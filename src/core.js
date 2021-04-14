import csstree from 'css-tree'
import debug from 'debug'
import pruneNonCriticalSelectors from './browser-sandbox/pruneNonCriticalSelectors'
import replacePageCss from './browser-sandbox/replacePageCss'
import cleanupAst from './postformatting'
import buildSelectorProfile from './selectors-profile'
import nonMatchingMediaQueryRemover from './non-matching-media-query-remover'

const debuglog = debug('penthouse:core')

const PUPPETEER_PAGE_UNLOADED_DURING_EXECUTION_ERROR_REGEX = /(Cannot find context with specified id|Execution context was destroyed)/
export const PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE =
  'PAGE_UNLOADED_DURING_EXECUTION: Critical css generation script could not be executed.\n\nThis can happen if Penthouse was killed during execution, OR otherwise most commonly if the page navigates away after load, via setting window.location, meta tag refresh directive or similar. For the critical css generation to work the loaded page must stay: remove any redirects or move them to the server. You can also disable them on your end just for the critical css generation, for example via a query parameter.'

function loadPage (
  page,
  url,
  htmlContentURL,
  isHTMLWithURL,
  timeout,
  pageLoadSkipTimeout,
  allowedResponseCode
) {
  debuglog('page load start')
  let waitingForPageLoad = true

  // change the url to the html content url - the request will be intercepted and the html will be changed within
  // the request interception method
  if (isHTMLWithURL === true) {
    debuglog(
      'changing url [',
      url,
      '] to the htmlcontenturl [',
      htmlContentURL,
      ']'
    )
    url = htmlContentURL
  }

  let loadPagePromise = page.goto(url)
  if (pageLoadSkipTimeout) {
    loadPagePromise = Promise.race([
      loadPagePromise,
      new Promise(resolve => {
        // _abort_ page load after X time,
        // in order to deal with spammy pages that keep sending non-critical requests
        // (tracking etc), which would otherwise never load.
        // With JS disabled it just shouldn't take that many seconds to load what's needed
        // for critical viewport.
        setTimeout(() => {
          if (waitingForPageLoad) {
            debuglog(
              'page load waiting ABORTED after ' +
                pageLoadSkipTimeout / 1000 +
                's. '
            )
            resolve()
          }
        }, pageLoadSkipTimeout)
      })
    ])
  }
  return loadPagePromise.then(response => {
    if (typeof allowedResponseCode !== 'undefined') {
      checkResponseStatus(allowedResponseCode, response)
    }

    waitingForPageLoad = false
    debuglog('page load DONE')
  })
}

function checkResponseStatus (allowedResponseCode, response) {
  var errorMessage
  if (
    typeof allowedResponseCode === 'number' &&
    response.status() !== allowedResponseCode
  ) {
    errorMessage = `Server response status ${response.status()} isn't matching allowedResponseCode: ${allowedResponseCode}.`
  } else if (
    typeof allowedResponseCode === 'object' &&
    allowedResponseCode.constructor.name === 'RegExp' &&
    !response
      .status()
      .toString()
      .match(allowedResponseCode)
  ) {
    errorMessage = `Server response status ${response.status()} isn't matching allowedResponseCode: ${allowedResponseCode.toString()}.`
  } else if (
    typeof allowedResponseCode === 'function' &&
    !allowedResponseCode.call(this, response)
  ) {
    errorMessage = `Server response status ${response.status()} isn't matching allowedResponseCode.`
  }

  if (errorMessage) {
    throw new Error(errorMessage)
  }
}

function setupRequestChecker (
  page,
  blockJSRequests,
  blockRequestURLs,
  html,
  htmlContentURL,
  isHTMLWithURL
) {
  page.on('request', interceptedRequest => {
    debuglog(
      'intercepted request - ',
      interceptedRequest.url().substring(0, 150)
    )

    // if the requesed url matches the html content url AND it is an html request with a url
    // do not do requests that are src requests (this is only for situations when html is passed
    // in with a url for relative paths)
    if (isHTMLWithURL === true) {
      if (
        interceptedRequest.url() === htmlContentURL ||
        interceptedRequest.url() === htmlContentURL + '/'
      ) {
        debuglog('intercepting url and replacing with html', htmlContentURL)
        interceptedRequest.respond({
          body: html
        })
        return
      }
    }

    // if we want to block all js requests
    if (blockJSRequests === true) {
      const isJsRequest = /\.js(\?.*)?$/.test(interceptedRequest.url())
      if (isJsRequest) {
        debuglog('blocking request; blocking all js requests')
        interceptedRequest.abort()
        return
      }
    }

    // block any request that exists within the list of requests to block
    for (let i = 0; i < blockRequestURLs.length; i++) {
      let rurl = blockRequestURLs[i]
      if (interceptedRequest.url().match(rurl)) {
        debuglog('blocking request; exists in block request urls')
        interceptedRequest.abort()
        return
      }
    }

    interceptedRequest.continue()
  })
  return page.setRequestInterception(true)
}

async function astFromCss ({ cssString, strict }) {
  // breaks puppeteer
  const css = cssString.replace(/￿/g, '\f042')

  const parsingErrors = []
  debuglog('parse ast START')
  const ast = csstree.parse(css, {
    onParseError: error => parsingErrors.push(error.formattedMessage)
  })
  debuglog(`parse ast DONE (with ${parsingErrors.length} errors)`)

  if (parsingErrors.length && strict === true) {
    // NOTE: only informing about first error, even if there were more than one.
    const parsingErrorMessage = parsingErrors[0]
    throw new Error(
      `AST parser (css-tree) found ${parsingErrors.length} errors in CSS.
      Breaking because in strict mode.
      The first error was:
      ` + parsingErrorMessage
    )
  }
  return ast
}

async function preparePage ({
  page,
  pagePromise,
  blockRequestURLs,
  html,
  htmlContentURL,
  isHTMLWithURL,
  width,
  height,
  cookies,
  userAgent,
  customPageHeaders,
  blockJSRequests,
  cleanupAndExit,
  getHasExited
}) {
  let reusedPage
  try {
    const pagePromiseResult = await pagePromise
    page = pagePromiseResult.page
    reusedPage = pagePromiseResult.reused
  } catch (e) {
    debuglog('unexpected: could not get an open browser page' + e)
    return
  }
  // we already exited while page was opening, stop execution
  // (strict mode ast css parsing erros)
  if (getHasExited()) {
    return
  }
  debuglog('open page ready in browser')

  // We set the viewport size in the browser when it launches,
  // and then re-use it for each page (to avoid extra work).
  // Only if later pages use a different viewport size do we need to
  // update it here.
  let setViewportPromise = Promise.resolve()
  const currentViewport = page.viewport()
  if (currentViewport.width !== width || currentViewport.height !== height) {
    setViewportPromise = page
      .setViewport({ width, height })
      .then(() => debuglog('viewport size updated'))
  }

  const setUserAgentPromise = page
    .setUserAgent(userAgent)
    .then(() => debuglog('userAgent set'))

  let setCustomPageHeadersPromise = Promise.resolve()
  if (customPageHeaders && Object.keys(customPageHeaders).length) {
    try {
      setCustomPageHeadersPromise = page
        .setExtraHTTPHeaders(customPageHeaders)
        .then(() =>
          debuglog('customPageHeaders set:' + JSON.stringify(customPageHeaders))
        )
    } catch (e) {
      debuglog('failed setting extra http headers: ' + e)
    }
  }

  let setCookiesPromise = Promise.resolve()
  if (cookies) {
    try {
      setCookiesPromise = page
        .setCookie(...cookies)
        .then(() => debuglog('cookie(s) set: ' + JSON.stringify(cookies)))
    } catch (e) {
      debuglog('failed to set cookies: ' + e)
    }
  }

  // assumes the page was already configured from previous call!
  if (reusedPage) {
    return Promise.all([
      setViewportPromise,
      setUserAgentPromise,
      setCustomPageHeadersPromise,
      setCookiesPromise
    ]).then(() => {
      debuglog('preparePage DONE')
      return page
    })
  }

  // disable Puppeteer navigation timeouts;
  // Penthouse tracks these internally instead.
  page.setDefaultNavigationTimeout(0)

  let requestPromise
  // NOTE: with JS disabled we cannot use JS timers inside page.evaluate
  // (setTimeout, setInterval), however requestAnimationFrame works.
  requestPromise = Promise.all([
    page.setJavaScriptEnabled(blockJSRequests === false),
    setupRequestChecker(
      page,
      blockJSRequests,
      blockRequestURLs,
      html,
      htmlContentURL,
      isHTMLWithURL
    )
  ]).then(() => {
    debuglog('blocking js requests DONE')
  })

  page.on('error', error => {
    debuglog('page error: ' + error)
    cleanupAndExit({ error })
  })
  page.on('console', msg => {
    const text = msg.text
      ? typeof msg.text === 'function'
        ? msg.text()
        : msg.text
      : msg
    // pass through log messages
    // - the ones sent by penthouse for debugging has 'debug: ' prefix.
    if (/^debug: /.test(text)) {
      debuglog(text.replace(/^debug: /, ''))
    }
  })
  debuglog('page event listeners set')

  return Promise.all([
    setViewportPromise,
    setUserAgentPromise,
    setCustomPageHeadersPromise,
    setCookiesPromise,
    blockJSRequestsPromise
  ]).then(() => {
    debuglog('preparePage DONE')
    return page
  })
}

async function grabPageScreenshot ({
  type,
  page,
  screenshots,
  screenshotExtension,
  debuglog
}) {
  const path = screenshots.basePath + `-${type}` + screenshotExtension
  debuglog(`take ${type} screenshot, START`)
  return page
    .screenshot({
      ...screenshots,
      path
    })
    .then(() => debuglog(`take ${type} screenshot DONE, path: ${path}`))
}

async function pruneNonCriticalCssLauncher ({
  pagePromise,
  url,
  html,
  htmlContentURL,
  blockRequestURLs,
  isHTMLWithURL,
  cssString,
  width,
  height,
  forceInclude,
  forceExclude,
  strict,
  userAgent,
  renderWaitTime,
  timeout,
  pageLoadSkipTimeout,
  blockJSRequests,
  customPageHeaders,
  cookies,
  screenshots,
  propertiesToRemove,
  maxEmbeddedBase64Length,
  keepLargerMediaQueries,
  maxElementsToCheckPerSelector,
  unstableKeepBrowserAlive,
  allowedResponseCode
}) {
  let _hasExited = false
  // hacky to get around _hasExited only available in the scope of this function
  const getHasExited = () => _hasExited

  const takeScreenshots = screenshots && screenshots.basePath
  const screenshotExtension =
    takeScreenshots && screenshots.type === 'jpeg' ? '.jpg' : '.png'

  // NOTE: would need a refactor to killTimeout logic to be able to remove promise here.
  /* eslint-disable no-async-promise-executor */
  return new Promise(async (resolve, reject) => {
    /* eslint-enable no-async-promise-executor */
    debuglog('Penthouse core start')
    let page = null
    let killTimeout = null
    async function cleanupAndExit ({ error, returnValue }) {
      if (_hasExited) {
        return
      }
      debuglog('cleanupAndExit')
      _hasExited = true
      clearTimeout(killTimeout)

      if (error) {
        return reject(error)
      }

      if (page) {
        const resetPromises = []
        // reset page headers and cookies,
        // since we re-use the page
        if (customPageHeaders && Object.keys(customPageHeaders).length) {
          try {
            resetPromises.push(
              page
                .setExtraHTTPHeaders({})
                .then(() => debuglog('customPageHeaders reset'))
            )
          } catch (e) {
            debuglog('failed resetting extra http headers: ' + e)
          }
        }
        // reset cookies
        if (cookies && cookies.length) {
          try {
            resetPromises.push(
              page
                .deleteCookie(...cookies)
                .then(() => debuglog('cookie(s) reset: '))
            )
          } catch (e) {
            debuglog('failed to reset cookies: ' + e)
          }
        }
        await Promise.all(resetPromises)
      }

      return resolve(returnValue)
    }
    killTimeout = setTimeout(() => {
      cleanupAndExit({
        error: new Error('Penthouse timed out after ' + timeout / 1000 + 's. ')
      })
    }, timeout)

    // 1. start preparing a browser page (tab) [NOT BLOCKING]
    const updatedPagePromise = preparePage({
      page,
      pagePromise,
      blockRequestURLs,
      html,
      htmlContentURL,
      isHTMLWithURL,
      width,
      height,
      userAgent,
      cookies,
      customPageHeaders,
      blockJSRequests,
      cleanupAndExit,
      getHasExited
    })

    // 2. parse ast
    // -> [BLOCK FOR] AST parsing
    let ast
    try {
      ast = await astFromCss({
        cssString,
        strict
      })
    } catch (e) {
      cleanupAndExit({ error: e })
      return
    }

    // 3. Further process the ast [BLOCKING]
    // Strip out non matching media queries.
    // Need to be done before buildSelectorProfile;
    // (very fast but could be done together/in parallel in future)
    nonMatchingMediaQueryRemover(ast, width, height, keepLargerMediaQueries)
    debuglog('stripped out non matching media queries')

    // -> [BLOCK FOR] page preparation
    page = await updatedPagePromise
    if (!page) {
      cleanupAndExit({ error: 'Could not open page in browser' })
      return
    }

    // load the page (slow) [NOT BLOCKING]
    const loadPagePromise = loadPage(
      page,
      url,
      htmlContentURL,
      isHTMLWithURL,
      timeout,
      pageLoadSkipTimeout,
      allowedResponseCode
    )

    // turn css to formatted selectorlist [NOT BLOCKING]
    debuglog('turn css to formatted selectorlist START')
    const buildSelectorProfilePromise = buildSelectorProfile(
      ast,
      forceInclude && forceInclude.length ? forceInclude : null,
      forceExclude && forceExclude.length ? forceExclude : null
    ).then(res => {
      debuglog('turn css to formatted selectorlist DONE')
      return res
    })

    // -> [BLOCK FOR] page load
    try {
      await loadPagePromise
    } catch (e) {
      cleanupAndExit({ error: e })
      return
    }
    if (!page) {
      // in case we timed out
      debuglog('page load TIMED OUT')
      cleanupAndExit({ error: new Error('Page load timed out') })
      return
    }
    if (_hasExited) return

    // Penthouse waits for the `load` event to fire
    // (before loadPagePromise resolves; except for very slow loading pages)
    // (via default puppeteer page.goto options.waitUntil setting,
    //  https://github.com/GoogleChrome/puppeteer/blob/v1.8.0/docs/api.md#pagegotourl-options)
    // This means "all of the objects in the document are in the DOM, and all the images...
    // have finished loading".
    // This is necessary for Penthouse to know the correct layout of the critical viewport
    // (well really, we would only need to load the critical viewport.. not possible?)

    // However, @font-face's can be available later,
    // and for this reason it can be useful to delay further - if screenshots are used.
    // For this `renderWaitTime` can be used.

    // Note: `renderWaitTime` is not a very good name,
    // and just setting a time is also not the most effective solution to f.e. wait for fonts.
    // In future probably deprecate and allow for a custom function instead (returning a promise).

    // -> [BLOCK FOR] renderWaitTime - needs to be done before we take any screenshots
    await new Promise(resolve => {
      setTimeout(() => {
        debuglog('waited for renderWaitTime: ' + renderWaitTime)
        resolve()
      }, renderWaitTime)
    })

    // take before screenshot (optional) [NOT BLOCKING]
    const beforeScreenshotPromise = takeScreenshots
      ? grabPageScreenshot({
          type: 'before',
          page,
          screenshots,
          screenshotExtension,
          debuglog
        })
      : Promise.resolve()

    // -> [BLOCK FOR] css into formatted selectors list with "sourcemap"
    // latter used to map back to full css rule
    const { selectors, selectorNodeMap } = await buildSelectorProfilePromise

    if (getHasExited()) {
      return
    }

    // -> [BLOCK FOR] critical css selector pruning (in browser)
    let criticalSelectors
    try {
      criticalSelectors = await page
        .evaluate(pruneNonCriticalSelectors, {
          selectors,
          renderWaitTime,
          maxElementsToCheckPerSelector
        })
        .then(criticalSelectors => {
          debuglog('pruneNonCriticalSelectors done')
          return criticalSelectors
        })
    } catch (err) {
      debuglog('pruneNonCriticalSelector threw an error: ' + err)
      const errorDueToPageUnloaded = PUPPETEER_PAGE_UNLOADED_DURING_EXECUTION_ERROR_REGEX.test(
        err
      )
      cleanupAndExit({
        error: errorDueToPageUnloaded
          ? new Error(PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE)
          : err
      })
      return
    }
    if (getHasExited()) {
      return
    }

    // -> [BLOCK FOR] clean up final ast for critical css
    debuglog('AST cleanup START')

    // NOTE: this function mutates the AST
    cleanupAst({
      ast,
      selectorNodeMap,
      criticalSelectors,
      propertiesToRemove,
      maxEmbeddedBase64Length
    })
    debuglog('AST cleanup DONE')

    // -> [BLOCK FOR] generate final critical css from critical ast
    const css = csstree.generate(ast)
    debuglog('generated CSS from AST')

    // take after screenshot (optional) [BLOCKING]
    if (takeScreenshots) {
      // wait for the before screenshot, before start modifying the page
      await beforeScreenshotPromise
      debuglog('inline critical styles for after screenshot')
      await page.evaluate(replacePageCss, { css }).then(() => {
        return grabPageScreenshot({
          type: 'after',
          page,
          screenshots,
          screenshotExtension,
          debuglog
        })
      })
    }
    debuglog('generateCriticalCss DONE')

    cleanupAndExit({ returnValue: css })
  })
}

export default pruneNonCriticalCssLauncher
