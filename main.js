// ==UserScript==
// @name        x'save
// @version     1.0.2-2026.11.20
// @namespace   kaiery.xsave
// @description 为 X/Twitter 添加图片与视频下载按钮，支持多码率直链复制、HLS 音视频合并、下载历史和进度日志。
// @match       https://twitter.com/*
// @match       https://x.com/*
// @homepageURL
// @supportURL
// @license     GPL-3.0
// @grant       GM.registerMenuCommand
// @grant       GM.setClipboard
// @require     https://cdn.jsdelivr.net/npm/mediabunny@1.66.1/dist/bundles/mediabunny.cjs
// @run-at      document-end
// @icon
// @author      kaiery
// @downloadURL
// @updateURL
// ==/UserScript==

const platformHostLabel = location.hostname.replace(".com", "");
const {
  StorageNames: storageKeys,
  StorageNamesOld: legacyStorageKeys
} = defineStorageKeyCatalog();
const {
  verbose: traceEnabled,
  debugPopup: preferencesPreviewEnabled
} = readDiagnosticPreferences();
const downloadDiagnostics = createDownloadDiagnostics();
downloadDiagnostics.info(null, "脚本开始运行", {
  version: "1.0.2-2026.11.19",
  hlsLibraryLoaded: typeof Mediabunny !== "undefined"
});
const {
  sleep: waitForMilliseconds,
  fetchResource: requestMediaBlob,
  fetchVideoResource: resolveAndFetchVideo,
  downloadBlob: savePayloadToDevice,
  addCSS: insertPageStyles,
  getCookie: readCookieValue,
  throttle: limitInvocationFrequency,
  xpath: findXpathNode,
  xpathAll: findAllXpathNodes,
  responseProgressProxy: observeResponseBytes,
  formatDate: formatCalendarDate,
  toLineJSON: serializeHistoryDocument,
  isFirefox: firefoxBrowserDetected,
  isFirefoxUserscriptContext: firefoxSandboxDetected,
  getBrowserName: detectBrowserFamily,
  removeSearchParams: stripAddressQuery,
  renderTemplateString: fillFilenamePattern,
  formatSizeWinLike: formatReadableByteCount,
  getVideoLinkOptions: describeVideoSourceChoices,
  copyText: copyAddressToClipboard
} = createRuntimeUtilities({
  verbose: traceEnabled
});
const JsonStorage = defineJsonStorage({
  verbose: traceEnabled
});
const PostService = definePostService();
const PostContext = definePostContext();
const PageEnhancements = definePageEnhancements();
const localizedLabels = readLocalizedLabels();
const {
  downloadedImages: savedImageNames,
  downloadedImageTweetIds: savedImagePostKeys,
  downloadedVideoTweetIds: savedVideoPostKeys,
  imagesHistoryBy: imageHistoryStrategy
} = initializeSavedMediaStores();
function defineStorageKeyCatalog() {
  const storageKeys = {
    settings: "ujs-twitter-click-n-save-settings",
    settingsImageHistoryBy: "ujs-twitter-click-n-save-settings-image-history-by",
    downloadedImageNames: "ujs-twitter-click-n-save-downloaded-image-names",
    downloadedImageTweetIds: "ujs-twitter-click-n-save-downloaded-image-tweet-ids",
    downloadedVideoTweetIds: "ujs-twitter-click-n-save-downloaded-video-tweet-ids",
    migrated: "ujs-twitter-click-n-save-migrated",
    browserName: "ujs-twitter-click-n-save-browser-name",
    verbose: "ujs-twitter-click-n-save-verbose",
    debugPopup: "ujs-twitter-click-n-save-debug-popup"
  };
  const legacyStorageKeys = {
    settings: "ujs-click-n-save-settings",
    settingsImageHistoryBy: "ujs-images-history-by",
    downloadedImageNames: "ujs-twitter-downloaded-images-names",
    downloadedImageTweetIds: "ujs-twitter-downloaded-image-tweet-ids",
    downloadedVideoTweetIds: "ujs-twitter-downloaded-video-tweet-ids"
  };
  return {
    StorageNames: storageKeys,
    StorageNamesOld: legacyStorageKeys
  };
}
function readDiagnosticPreferences() {
  let traceEnabled = false;
  let preferencesPreviewEnabled = false;
  try {
    traceEnabled = Boolean(JSON.parse(localStorage.getItem(storageKeys.verbose)));
  } catch (caughtFailure) {}
  try {
    preferencesPreviewEnabled = Boolean(JSON.parse(localStorage.getItem(storageKeys.debugPopup)));
  } catch (caughtFailure) {}
  return {
    verbose: traceEnabled,
    debugPopup: preferencesPreviewEnabled
  };
}
function createDownloadDiagnostics() {
  let diagnosticsActive = true;
  try {
    diagnosticsActive = localStorage.getItem("ujs-twitter-click-n-save-download-logs") !== "false";
  } catch (caughtFailure) {}
  let diagnosticTaskCounter = 0;
  function writeDiagnosticEntry(diagnosticSeverity, downloadTaskKey, diagnosticMessage, diagnosticFields, overrideDiagnosticPreference = false) {
    if (!diagnosticsActive && !overrideDiagnosticPreference) {
      return;
    }
    try {
      const diagnosticEntryLabel = `[TwitterSave][${new Date().toISOString()}][${downloadTaskKey || "全局"}] ${diagnosticMessage}`;
      console[diagnosticSeverity](diagnosticEntryLabel, diagnosticFields || "");
    } catch (caughtFailure) {}
  }
  const writeStatusLog = (downloadTaskKey, diagnosticMessage, diagnosticFields) => writeDiagnosticEntry("log", downloadTaskKey, diagnosticMessage, diagnosticFields);
  const writeWarningLog = (downloadTaskKey, diagnosticMessage, diagnosticFields) => writeDiagnosticEntry("warn", downloadTaskKey, diagnosticMessage, diagnosticFields);
  const writeFailureLog = (downloadTaskKey, diagnosticMessage, diagnosticFields) => writeDiagnosticEntry("error", downloadTaskKey, diagnosticMessage, diagnosticFields);
  function createWaitHeartbeat(downloadTaskKey, transferStageLabel) {
    if (!diagnosticsActive || !downloadTaskKey) {
      return () => {};
    }
    const waitStartedAt = Date.now();
    const heartbeatTimer = setInterval(() => writeWarningLog(downloadTaskKey, `仍在等待：${transferStageLabel}`, {
      elapsedSeconds: Math.round((Date.now() - waitStartedAt) / 1000)
    }), 15000);
    return () => clearInterval(heartbeatTimer);
  }
  function createTransferObserver(downloadTaskKey, transferStageLabel) {
    if (!diagnosticsActive || !downloadTaskKey) {
      return {
        progress() {},
        stop() {}
      };
    }
    let lastReportTime = -Infinity;
    let lastActivityTime = Date.now();
    let transferredByteCount = 0;
    let completionAlreadyReported = false;
    const heartbeatTimer = setInterval(() => {
      const secondsWithoutActivity = Math.floor((Date.now() - lastActivityTime) / 1000);
      if (secondsWithoutActivity >= 15) {
        writeWarningLog(downloadTaskKey, `${transferStageLabel} 暂无新进展，仍在等待`, {
          idleSeconds: secondsWithoutActivity,
          loadedBytes: transferredByteCount
        });
      }
    }, 15000);
    return {
      progress(transferUpdate) {
        lastActivityTime = Date.now();
        transferredByteCount = transferUpdate.loaded;
        const completedPortion = Number.isFinite(transferUpdate.progress) ? transferUpdate.progress : transferUpdate.total > 0 ? transferUpdate.loaded / transferUpdate.total : null;
        const isTransferComplete = completedPortion !== null && completedPortion >= 1;
        if (lastActivityTime - lastReportTime < 2000 && !(isTransferComplete && !completionAlreadyReported)) {
          return;
        }
        lastReportTime = lastActivityTime;
        completionAlreadyReported = isTransferComplete;
        writeStatusLog(downloadTaskKey, `${transferStageLabel} 进度`, {
          percent: completedPortion === null ? "未知总大小" : `${Math.min(100, Math.floor(completedPortion * 100))}%`,
          downloadedMB: Number((transferredByteCount / 1024 / 1024).toFixed(2)),
          loadedBytes: transferredByteCount,
          totalBytes: transferUpdate.total > 0 ? transferUpdate.total : null
        });
      },
      stop() {
        clearInterval(heartbeatTimer);
      }
    };
  }
  return {
    info: writeStatusLog,
    warn: writeWarningLog,
    error: writeFailureLog,
    wait: createWaitHeartbeat,
    monitor: createTransferObserver,
    links(downloadTaskKey, selectedMediaDescriptor, overrideDiagnosticPreference = false) {
      const progressiveSourceAddresses = [...new Set(selectedMediaDescriptor.download_urls || (selectedMediaDescriptor.download_url ? [selectedMediaDescriptor.download_url] : []))];
      const streamingPlaylistAddresses = [...new Set(selectedMediaDescriptor.hls_urls || [])];
      const mediaDescriptor = selectedMediaDescriptor.media_id ? ` [媒体 ${selectedMediaDescriptor.media_id}]` : "";
      progressiveSourceAddresses.forEach((resourceAddress, entryPosition) => writeDiagnosticEntry("log", downloadTaskKey, `MP4 完整下载地址 #${entryPosition + 1}${mediaDescriptor}${entryPosition === 0 ? "（优先尝试）" : ""}`, resourceAddress, overrideDiagnosticPreference));
      streamingPlaylistAddresses.forEach((resourceAddress, entryPosition) => writeDiagnosticEntry("log", downloadTaskKey, `HLS 播放列表地址 #${entryPosition + 1}${mediaDescriptor}（需要下载分片并合并）`, resourceAddress, overrideDiagnosticPreference));
      if (!progressiveSourceAddresses.length) {
        writeDiagnosticEntry("warn", downloadTaskKey, streamingPlaylistAddresses.length ? "此视频只有 HLS 播放列表，没有单文件 MP4 直链" : "此视频未提供可用下载地址", null, overrideDiagnosticPreference);
      }
    },
    start(diagnosticFields) {
      const downloadTaskKey = `V${++diagnosticTaskCounter}`;
      writeStatusLog(downloadTaskKey, "收到下载点击", diagnosticFields);
      return downloadTaskKey;
    },
    url(entryContent) {
      try {
        const resourceAddress = new URL(entryContent);
        return resourceAddress.origin + resourceAddress.pathname;
      } catch (caughtFailure) {
        return "(无有效地址)";
      }
    },
    errorDetails(caughtFailure) {
      return {
        name: caughtFailure?.name,
        message: caughtFailure?.message || String(caughtFailure),
        status: caughtFailure?.status,
        stack: caughtFailure?.stack
      };
    }
  };
}
const historyOperations = createHistoryOperations();
historyOperations.migrateLocalStore();
const calendarOutputPattern = "YYYY.MM.DD";
const imageOutputNamePattern = `[twitter]{sampleText} {author}—{lastModifiedDate}—{tweetId}—{name}.{extension}`;
const videoOutputNamePattern = `[twitter] {author}—{lastModifiedDate}—{tweetId}—{name}.{extension}`;
const profileBackdropNamePattern = `[twitter][bg] {username}—{lastModifiedDate}—{id}—{seconds}.{extension}`;
if (typeof GM === "object" && typeof GM?.registerMenuCommand === "function") {
  void GM.registerMenuCommand("Show settings", presentPreferencesDialog);
}
const runtimePreferences = readSavedPreferences();
if (traceEnabled) {
  console.log("[ujs][settings]", runtimePreferences);
}
if (preferencesPreviewEnabled) {
  presentPreferencesDialog();
}
const performPageRequest = selectCompatibleRequestFunction({
  verbose: traceEnabled,
  strictTrackingProtectionFix: runtimePreferences.strictTrackingProtectionFix
});
function selectCompatibleRequestFunction({
  verbose: traceEnabled = false,
  strictTrackingProtectionFix: enableFirefoxRequestBridge = true
} = {}) {
  const firefoxBridgeAvailable = firefoxSandboxDetected && typeof wrappedJSObject.fetch === "function";
  if (enableFirefoxRequestBridge && firefoxBridgeAvailable) {
    return function performFirefoxBridgeRequest(requestedResource, requestConfiguration = {}) {
      traceEnabled && console.log("[ujs][wrappedJSObject.fetch]", requestedResource, requestConfiguration);
      if (requestConfiguration.headers instanceof Headers) {
        requestConfiguration.headers = Object.fromEntries(requestConfiguration.headers.entries());
      }
      return wrappedJSObject.fetch(cloneInto(requestedResource, document), cloneInto(requestConfiguration, document));
    };
  }
  return globalThis.fetch;
}
const suppressVideoAutoplay = false;
function initializePageEnhancements() {
  runtimePreferences.goFromMobileToMainSite && PageEnhancements.redirectMobileHost();
  runtimePreferences.addRequiredCSS && PageEnhancements.installEnhancementStyles();
  runtimePreferences.hideSignUpBottomBarAndMessages && PageEnhancements.concealRegistrationOverlay(suppressVideoAutoplay);
  runtimePreferences.hideTrends && PageEnhancements.concealTrendPanel();
  runtimePreferences.highlightVisitedLinks && PageEnhancements.styleVisitedDestinations();
  runtimePreferences.hideLoginPopup && PageEnhancements.concealAuthenticationPopup();
  runtimePreferences.cssRemoveMultimediaCarousel && PageEnhancements.flattenMediaCarousel();
}
function refreshImmediateEnhancements() {}
function refreshPageEnhancements() {
  runtimePreferences.imagesHandler && PageEnhancements.scanImageElements();
  runtimePreferences.videoHandler && PageEnhancements.scanVideoPlayers();
  runtimePreferences.hideSignUpSection && PageEnhancements.concealRegistrationPanel();
  runtimePreferences.directLinks && PageEnhancements.resolveRedirectedLinks();
  runtimePreferences.handleTitle && PageEnhancements.refreshReadablePageTitle();
  runtimePreferences.cssRemoveMultimediaCarousel && PageEnhancements.tagMediaCollections();
}
(function startEnhancementObserver(enhancementStages) {
  const {
    once: initializeEnhancements,
    onChangeImmediate: refreshUrgentEnhancements,
    onChange: refreshEnhancements
  } = enhancementStages;
  initializeEnhancements();
  refreshUrgentEnhancements();
  const refreshEnhancementsAtInterval = limitInvocationFrequency(refreshEnhancements, 250);
  refreshEnhancementsAtInterval();
  const observedPageRoot = document.querySelector("body");
  const mutationObserverConfiguration = {
    subtree: true,
    childList: true
  };
  const pageMutationObserver = new MutationObserver(handleObservedMutations);
  pageMutationObserver.observe(observedPageRoot, mutationObserverConfiguration);
  function handleObservedMutations(observedMutations, originatingMutationObserver) {
    traceEnabled && console.log("[ujs][mutationList]", observedMutations);
    refreshUrgentEnhancements();
    refreshEnhancementsAtInterval();
  }
})({
  once: initializePageEnhancements,
  onChangeImmediate: refreshImmediateEnhancements,
  onChange: refreshPageEnhancements
});
downloadDiagnostics.info(null, "脚本初始化完成，等待下载按钮点击");
function readSavedPreferences() {
  const defaultPreferences = {
    hideTrends: true,
    hideSignUpSection: false,
    hideSignUpBottomBarAndMessages: false,
    doNotPlayVideosAutomatically: false,
    goFromMobileToMainSite: false,
    highlightVisitedLinks: true,
    highlightOnlySpecialVisitedLinks: true,
    expandSpoilers: false,
    directLinks: true,
    handleTitle: true,
    imagesHandler: true,
    videoHandler: true,
    addRequiredCSS: true,
    hideLoginPopup: false,
    addBorder: true,
    cssRemoveMultimediaCarousel: true,
    strictTrackingProtectionFix: true
  };
  let persistedPreferences;
  try {
    persistedPreferences = JSON.parse(localStorage.getItem(storageKeys.settings)) || {};
  } catch (caughtFailure) {
    console.error("[ujs][parse-settings]", caughtFailure);
    localStorage.removeItem(storageKeys.settings);
    persistedPreferences = {};
  }
  persistedPreferences = Object.assign(defaultPreferences, persistedPreferences);
  return persistedPreferences;
}
function presentPreferencesDialog() {
  dismissPreferences();
  if (window.scrollY > 0) {
    document.querySelector("html").classList.add("ujs-scroll-initial");
    document.body.classList.add("ujs-scrollbar-width-margin-right");
  }
  document.body.classList.add("ujs-no-scroll");
  const preferencesOverlayStyle = `
    color-scheme: light;
    width: 100%;
    height: 100%;
    position: fixed;
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 99999;
    backdrop-filter: blur(4px);
    background-color: rgba(255, 255, 255, 0.5);
  `;
  const preferencesPanelStyle = `
    background-color: white;
    min-width: 320px;
    min-height: 320px;
    border: 1px solid darkgray;
    padding: 8px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
  `;
  const dialogPreferences = runtimePreferences;
  const firefoxBridgeHelpText = `Choose this if you use Firefox with "Enhanced Tracking Protection" set to "Strict".`;
  document.body.insertAdjacentHTML("afterbegin", `
  <div class="ujs-modal-wrapper" style="${preferencesOverlayStyle}">
      <div class="ujs-modal-settings" style="${preferencesPanelStyle}">
          <fieldset>
              <legend>Optional</legend>
              <label title="Makes the button more visible"><input type="checkbox" ${dialogPreferences.addBorder ? "checked" : ""} name="addBorder">Add a white border to the download button<br/></label>
              <label title="WARNING: It may broke the login page, but it works fine if you logged in and want to hide 'Messages'"><input type="checkbox" ${dialogPreferences.hideSignUpBottomBarAndMessages ? "checked" : ""} name="hideSignUpBottomBarAndMessages">Hide <strike><b>Sign Up Bar</b> and</strike> <b>Messages</b> and <b>Cookies</b> (in the bottom). <span title="WARNING: It may broke the login page!">(beta)</span><br/></label>
              <label><input type="checkbox" ${dialogPreferences.hideTrends ? "checked" : ""} name="hideTrends">Hide <b>Trends</b> (in the right column)*<br/></label>
              <label hidden><input type="checkbox" ${dialogPreferences.doNotPlayVideosAutomatically ? "checked" : ""} name="doNotPlayVideosAutomatically">Do <i>Not</i> Play Videos Automatically</b><br/></label>
              <label hidden><input type="checkbox" ${dialogPreferences.goFromMobileToMainSite ? "checked" : ""} name="goFromMobileToMainSite">Redirect from Mobile version (beta)<br/></label>
          </fieldset>
          <fieldset>
              <legend>Recommended</legend>
              <label><input type="checkbox" ${dialogPreferences.highlightVisitedLinks ? "checked" : ""} name="highlightVisitedLinks">Highlight Visited Links<br/></label>
              <label title="In most cases absolute links are 3rd-party links"><input type="checkbox" ${dialogPreferences.highlightOnlySpecialVisitedLinks ? "checked" : ""} name="highlightOnlySpecialVisitedLinks">Highlight Only Absolute Visited Links<br/></label>
          </fieldset>
          <fieldset>
              <legend>Highly Recommended</legend>
              <label><input type="checkbox" ${dialogPreferences.cssRemoveMultimediaCarousel ? "checked" : ""} name="cssRemoveMultimediaCarousel">Remove <b>Carousel</b> for multimedia tweets<br/></label>
              <label><input type="checkbox" ${dialogPreferences.directLinks ? "checked" : ""} name="directLinks">Direct Links</label><br/>
              <label><input type="checkbox" ${dialogPreferences.handleTitle ? "checked" : ""} name="handleTitle">Enchance Title*<br/></label>
          </fieldset>
          <fieldset ${firefoxBrowserDetected ? '' : 'style="display: none"'}>
              <legend>Firefox only</legend>
              <label title='${firefoxBridgeHelpText}'><input type="checkbox" ${dialogPreferences.strictTrackingProtectionFix ? "checked" : ""} name="strictTrackingProtectionFix">Strict Tracking Protection Fix<br/></label>
          </fieldset>
          <fieldset>
              <legend>Main</legend>
              <label><input type="checkbox" ${dialogPreferences.imagesHandler ? "checked" : ""} name="imagesHandler">Image Download Button<br/></label>
              <label><input type="checkbox" ${dialogPreferences.videoHandler ? "checked" : ""} name="videoHandler">Video Download Button<br/></label>
              <label hidden><input type="checkbox" ${dialogPreferences.addRequiredCSS ? "checked" : ""} name="addRequiredCSS">Add Required CSS*<br/></label>
          </fieldset>
          <fieldset>
              <legend title="Outdated due to Twitter's updates, or impossible to reimplement">Outdated</legend>
              <strike>

              <label><input type="checkbox" ${dialogPreferences.hideSignUpSection ? "checked" : ""} name="hideSignUpSection">Hide <b title='"New to Twitter?" (If yoy are not logged in)'>Sign Up</b> section (in the right column)*<br/></label>
              <label title="Hides the modal login pop up. Useful if you have no account. \nWARNING: Currently it will close any popup, not only the login one.\nIt's recommended to use only if you do not have an account to hide the annoiyng login popup."><input type="checkbox" ${dialogPreferences.hideLoginPopup ? "checked" : ""} name="hideLoginPopup">Hide <strike>Login</strike> Popups. (beta)<br/></label>
              <label title="Note: since the recent update the most NSFW spoilers are impossible to expand without an account"><input type="checkbox" ${dialogPreferences.expandSpoilers ? "checked" : ""} name="expandSpoilers">Expand Spoilers (if possible)*<br/></label>

              </strike>
          </fieldset>
          <hr>
          <div style="display: flex; justify-content: space-around;">
              <div>
                History:
                <button class="ujs-reload-export-button" style="padding: 5px" >Export</button>
                <button class="ujs-reload-import-button" style="padding: 5px" >Import</button>
                <button class="ujs-reload-merge-button"  style="padding: 5px" >Merge</button>
              </div>
              <div>
                <button class="ujs-reload-setting-button" style="padding: 5px" title="Reload the web page to apply changes">Reload page</button>
                <button class="ujs-close-setting-button" style="padding: 5px" title="Just close this popup.\nNote: You need to reload the web page to apply changes.">Close popup</button>
              </div>
          </div>
          <hr>
          <h4 style="margin: 0; padding-left: 8px; color: #444;">Notes:</h4>
          <ul style="margin: 2px; padding-left: 16px; color: #444;">
            <li><b>Reload the page</b> to apply changes.</li>
            <li><b>*</b>-marked settings are language dependent. Currently, the follow languages are supported:<br/> "en", "ru", "es", "zh", "ja".</li>
            <li hidden>The extension downloads only from twitter.com, not from <b>mobile</b>.twitter.com</li>
          </ul>
      </div>
  </div>`);
  async function handleOperationSuccess(actionControl) {
    actionControl.classList.remove("ujs-btn-error");
    actionControl.classList.add("ujs-btn-done");
    await waitForMilliseconds(900);
    actionControl.classList.remove("ujs-btn-done");
  }
  async function handleOperationFailure(actionControl, caughtFailure) {
    actionControl.classList.remove("ujs-btn-done");
    actionControl.classList.add("ujs-btn-error");
    actionControl.title = caughtFailure.message;
    await waitForMilliseconds(1800);
    actionControl.classList.remove("ujs-btn-error");
  }
  const historyExportControl = document.querySelector("body > .ujs-modal-wrapper .ujs-reload-export-button");
  const historyImportControl = document.querySelector("body > .ujs-modal-wrapper .ujs-reload-import-button");
  const historyMergeControl = document.querySelector("body > .ujs-modal-wrapper .ujs-reload-merge-button");
  historyExportControl.addEventListener("click", interactionEvent => {
    const actionControl = interactionEvent.currentTarget;
    historyOperations.exportHistory(() => handleOperationSuccess(actionControl));
  });
  waitForMilliseconds(50).then(() => {
    const historyStatistics = measureSavedStorage();
    historyExportControl.title = Object.entries(historyStatistics).reduce((collectedEntries, [propertyName, entryContent]) => {
      collectedEntries += `${propertyName}: ${entryContent}\n`;
      return collectedEntries;
    }, "");
  });
  historyImportControl.addEventListener("click", interactionEvent => {
    const actionControl = interactionEvent.currentTarget;
    historyOperations.importHistory(() => handleOperationSuccess(actionControl), caughtFailure => handleOperationFailure(actionControl, caughtFailure));
  });
  historyMergeControl.addEventListener("click", interactionEvent => {
    const actionControl = interactionEvent.currentTarget;
    historyOperations.mergeHistory(() => handleOperationSuccess(actionControl), caughtFailure => handleOperationFailure(actionControl, caughtFailure));
  });
  document.querySelector("body > .ujs-modal-wrapper .ujs-reload-setting-button").addEventListener("click", () => {
    location.reload();
  });
  const preferenceCheckboxes = document.querySelectorAll("body > .ujs-modal-wrapper input[type=checkbox], body > .ujs-modal-wrapper input[type=radio]");
  preferenceCheckboxes.forEach(preferenceCheckbox => {
    preferenceCheckbox.addEventListener("change", persistDialogPreferences);
  });
  document.querySelector("body > .ujs-modal-wrapper .ujs-close-setting-button").addEventListener("click", dismissPreferences);
  function persistDialogPreferences() {
    const propertyEntries = [...document.querySelectorAll("body > .ujs-modal-wrapper input[type=checkbox]")].map(preferenceCheckbox => [preferenceCheckbox.name, preferenceCheckbox.checked]);
    const historyStrategySelections = [...document.querySelectorAll("body > .ujs-modal-wrapper input[type=radio]")].map(preferenceCheckbox => [preferenceCheckbox.value, preferenceCheckbox.checked]);
    const runtimePreferences = Object.fromEntries([propertyEntries, historyStrategySelections].flat());
    localStorage.setItem(storageKeys.settings, JSON.stringify(runtimePreferences));
  }
  function dismissPreferences() {
    document.body.classList.remove("ujs-no-scroll");
    document.body.classList.remove("ujs-scrollbar-width-margin-right");
    document.querySelector("html").classList.remove("ujs-scroll-initial");
    document.querySelector("body > .ujs-modal-wrapper")?.remove();
  }
}
function initializeSavedMediaStores() {
  const savedImageNames = new JsonStorage(storageKeys.downloadedImageNames);
  const savedImagePostKeys = new JsonStorage(storageKeys.downloadedImageTweetIds);
  const savedVideoPostKeys = new JsonStorage(storageKeys.downloadedVideoTweetIds);
  const imageHistoryStrategy = JsonStorage.readJsonEntry(storageKeys.settingsImageHistoryBy, "IMAGE_NAME");
  return {
    downloadedImages: savedImageNames,
    downloadedImageTweetIds: savedImagePostKeys,
    downloadedVideoTweetIds: savedVideoPostKeys,
    imagesHistoryBy: imageHistoryStrategy
  };
}
function definePageEnhancements() {
  const failureIndicatorStyle = `background-image: url("https://abs-0.twimg.com/emoji/v2/svg/274c.svg"); background-size: 1.5em; background-position: center; background-repeat: no-repeat;`;
  const warningIndicatorStyle = `background-image: url("https://abs-0.twimg.com/emoji/v2/svg/26a0.svg"); background-size: 1.5em; background-position: center; background-repeat: no-repeat;`;
  class VideoSourceDropdown {
    static visibleDropdown = null;
    static dropdownSerial = 0;
    static mountSourceToggle(downloadControl) {
      downloadControl.classList.add("ujs-has-video-links");
      const sourceDropdownToggle = document.createElement("button");
      sourceDropdownToggle.type = "button";
      sourceDropdownToggle.className = "ujs-video-links-toggle";
      sourceDropdownToggle.textContent = "▾";
      sourceDropdownToggle.title = "显示并复制视频下载地址";
      sourceDropdownToggle.setAttribute("aria-label", sourceDropdownToggle.title);
      sourceDropdownToggle.setAttribute("aria-haspopup", "dialog");
      sourceDropdownToggle.setAttribute("aria-expanded", "false");
      for (const mediaCategory of ["pointerdown", "mousedown", "dblclick"]) {
        sourceDropdownToggle.addEventListener(mediaCategory, interactionEvent => interactionEvent.stopPropagation());
      }
      sourceDropdownToggle.addEventListener("click", interactionEvent => {
        interactionEvent.preventDefault();
        interactionEvent.stopImmediatePropagation();
        void VideoSourceDropdown.presentSourceList(downloadControl, sourceDropdownToggle);
      });
      downloadControl.append(sourceDropdownToggle);
    }
    static dismissSourceList(returnFocusToToggle = false) {
      const openedDropdown = VideoSourceDropdown.visibleDropdown;
      if (!openedDropdown) return;
      VideoSourceDropdown.visibleDropdown = null;
      document.removeEventListener("pointerdown", openedDropdown.outside, true);
      document.removeEventListener("keydown", openedDropdown.keyboard, true);
      window.removeEventListener("scroll", openedDropdown.viewport, true);
      window.removeEventListener("resize", openedDropdown.viewport);
      openedDropdown.panel.remove();
      openedDropdown.btn.classList.remove("ujs-links-open");
      openedDropdown.toggle.setAttribute("aria-expanded", "false");
      openedDropdown.toggle.removeAttribute("aria-controls");
      if (returnFocusToToggle && openedDropdown.toggle.isConnected) openedDropdown.toggle.focus();
    }
    static alignSourceList(openedDropdown) {
      const availableViewportWidth = document.documentElement.clientWidth || window.innerWidth;
      openedDropdown.panel.style.maxWidth = Math.max(0, availableViewportWidth - 16) + "px";
      const controlBounds = openedDropdown.toggle.getBoundingClientRect();
      const dropdownWidth = openedDropdown.panel.offsetWidth;
      const dropdownHeight = openedDropdown.panel.offsetHeight;
      openedDropdown.panel.style.left = Math.max(8, Math.min(controlBounds.left, availableViewportWidth - dropdownWidth - 8)) + "px";
      const dropdownTopOffset = controlBounds.bottom + 8 + dropdownHeight <= window.innerHeight - 8 ? controlBounds.bottom + 8 : controlBounds.top - dropdownHeight - 8;
      openedDropdown.panel.style.top = Math.max(8, Math.min(dropdownTopOffset, window.innerHeight - dropdownHeight - 8)) + "px";
    }
    static async presentSourceList(downloadControl, sourceDropdownToggle) {
      if (VideoSourceDropdown.visibleDropdown?.toggle === sourceDropdownToggle) {
        VideoSourceDropdown.dismissSourceList();
        return;
      }
      VideoSourceDropdown.dismissSourceList();
      const sourceDropdownPanel = document.createElement("section");
      sourceDropdownPanel.id = `ujs-video-links-menu-${++VideoSourceDropdown.dropdownSerial}`;
      sourceDropdownPanel.className = "ujs-video-links-menu";
      sourceDropdownPanel.setAttribute("role", "dialog");
      sourceDropdownPanel.setAttribute("aria-label", "视频下载地址");
      const dropdownHeader = document.createElement("div");
      dropdownHeader.className = "ujs-video-links-header";
      const displayTitle = document.createElement("strong");
      displayTitle.textContent = "视频下载地址";
      const dismissControl = document.createElement("button");
      dismissControl.type = "button";
      dismissControl.className = "ujs-video-links-close";
      dismissControl.textContent = "×";
      dismissControl.setAttribute("aria-label", "关闭视频地址列表");
      dismissControl.addEventListener("click", () => VideoSourceDropdown.dismissSourceList(true));
      dropdownHeader.append(displayTitle, dismissControl);
      const sourceChoicesContainer = document.createElement("div");
      sourceChoicesContainer.className = "ujs-video-links-list";
      const operationStatus = document.createElement("div");
      operationStatus.className = "ujs-video-links-status";
      operationStatus.setAttribute("role", "status");
      operationStatus.setAttribute("aria-live", "polite");
      operationStatus.textContent = "正在获取视频地址…";
      const manualCopyInput = document.createElement("input");
      manualCopyInput.className = "ujs-video-links-manual";
      manualCopyInput.type = "text";
      manualCopyInput.readOnly = true;
      manualCopyInput.hidden = true;
      manualCopyInput.setAttribute("aria-label", "手动复制完整视频地址");
      sourceDropdownPanel.append(dropdownHeader, sourceChoicesContainer, operationStatus, manualCopyInput);
      document.body.append(sourceDropdownPanel);
      const openedDropdown = {
        btn: downloadControl,
        toggle: sourceDropdownToggle,
        panel: sourceDropdownPanel,
        list: sourceChoicesContainer,
        status: operationStatus,
        manual: manualCopyInput,
        copying: false
      };
      openedDropdown.outside = interactionEvent => {
        if (!sourceDropdownPanel.contains(interactionEvent.target) && !sourceDropdownToggle.contains(interactionEvent.target)) VideoSourceDropdown.dismissSourceList();
      };
      openedDropdown.keyboard = interactionEvent => {
        if (interactionEvent.key === "Escape") {
          interactionEvent.preventDefault();
          interactionEvent.stopImmediatePropagation();
          VideoSourceDropdown.dismissSourceList(true);
        } else if (sourceDropdownPanel.contains(document.activeElement) && ["ArrowDown", "ArrowUp", "Home", "End"].includes(interactionEvent.key)) {
          const sourceChoiceControls = [...sourceChoicesContainer.querySelectorAll(".ujs-video-link-item")];
          if (!sourceChoiceControls.length) return;
          interactionEvent.preventDefault();
          const entryPosition = sourceChoiceControls.indexOf(document.activeElement);
          const nextChoicePosition = interactionEvent.key === "Home" ? 0 : interactionEvent.key === "End" ? sourceChoiceControls.length - 1 : (entryPosition + (interactionEvent.key === "ArrowDown" ? 1 : -1) + sourceChoiceControls.length) % sourceChoiceControls.length;
          sourceChoiceControls[nextChoicePosition].focus();
        }
      };
      openedDropdown.viewport = interactionEvent => {
        if (interactionEvent.type !== "scroll" || !sourceDropdownPanel.contains(interactionEvent.target)) VideoSourceDropdown.dismissSourceList();
      };
      VideoSourceDropdown.visibleDropdown = openedDropdown;
      sourceDropdownToggle.setAttribute("aria-expanded", "true");
      sourceDropdownToggle.setAttribute("aria-controls", sourceDropdownPanel.id);
      downloadControl.classList.add("ujs-links-open");
      document.addEventListener("pointerdown", openedDropdown.outside, true);
      document.addEventListener("keydown", openedDropdown.keyboard, true);
      window.addEventListener("scroll", openedDropdown.viewport, true);
      window.addEventListener("resize", openedDropdown.viewport);
      VideoSourceDropdown.alignSourceList(openedDropdown);
      dismissControl.focus({
        preventScroll: true
      });
      const downloadTaskKey = downloadDiagnostics.start({
        type: "video-link-menu"
      });
      try {
        const {
          id: postIdentifier
        } = PostContext.fromDescendant(downloadControl);
        const mediaDescriptors = await PostService.readPostMediaDescriptors(postIdentifier, downloadTaskKey);
        if (VideoSourceDropdown.visibleDropdown !== openedDropdown) return;
        const videoDescriptors = downloadControl.dataset.isMultiMedia ? mediaDescriptors.filter(mediaDescriptor => mediaDescriptor.type === "video" && mediaDescriptor.tweet_id === postIdentifier) : [MediaActions.selectMatchingVideo(mediaDescriptors, downloadControl.dataset.url)].filter(Boolean);
        if (!videoDescriptors.length) throw new Error("未找到对应视频，请打开推文详情后重试。");
        let entryCount = 0;
        videoDescriptors.forEach((mediaDescriptor, entryPosition) => {
          const sourceChoiceDescriptors = describeVideoSourceChoices(mediaDescriptor);
          if (videoDescriptors.length > 1) {
            const videoGroupHeading = document.createElement("div");
            videoGroupHeading.className = "ujs-video-links-group";
            videoGroupHeading.textContent = `视频 ${entryPosition + 1}`;
            sourceChoicesContainer.append(videoGroupHeading);
          }
          for (const sourceChoiceDescriptor of sourceChoiceDescriptors) {
            VideoSourceDropdown.appendSourceChoice(openedDropdown, sourceChoiceDescriptor, downloadTaskKey);
            entryCount++;
          }
        });
        operationStatus.textContent = entryCount ? "点击一项复制完整地址；HLS 地址需要分片合并。" : "此视频未提供可用的 MP4 或 HLS 地址。";
        downloadDiagnostics.info(downloadTaskKey, "下载地址列表已显示", {
          count: entryCount
        });
        VideoSourceDropdown.alignSourceList(openedDropdown);
      } catch (failureCause) {
        if (VideoSourceDropdown.visibleDropdown !== openedDropdown) return;
        operationStatus.dataset.state = "error";
        operationStatus.textContent = "获取地址失败：" + failureCause.message;
        const retryQueryControl = document.createElement("button");
        retryQueryControl.type = "button";
        retryQueryControl.className = "ujs-video-links-retry";
        retryQueryControl.textContent = "重试";
        retryQueryControl.addEventListener("click", () => {
          VideoSourceDropdown.dismissSourceList();
          void VideoSourceDropdown.presentSourceList(downloadControl, sourceDropdownToggle);
        });
        sourceChoicesContainer.append(retryQueryControl);
        downloadDiagnostics.error(downloadTaskKey, "获取下载地址失败", downloadDiagnostics.errorDetails(failureCause));
        VideoSourceDropdown.alignSourceList(openedDropdown);
      }
    }
    static appendSourceChoice(openedDropdown, sourceChoiceDescriptor, downloadTaskKey) {
      const sourceChoiceControl = document.createElement("button");
      sourceChoiceControl.type = "button";
      sourceChoiceControl.className = "ujs-video-link-item";
      sourceChoiceControl.title = sourceChoiceDescriptor.label;
      const diagnosticEntryLabel = document.createElement("span");
      diagnosticEntryLabel.className = "ujs-video-link-label";
      diagnosticEntryLabel.textContent = sourceChoiceDescriptor.label;
      const addressTextElement = document.createElement("span");
      addressTextElement.className = "ujs-video-link-url";
      addressTextElement.textContent = sourceChoiceDescriptor.url;
      const copyStateIndicator = document.createElement("span");
      copyStateIndicator.className = "ujs-video-link-copy";
      copyStateIndicator.textContent = "复制";
      sourceChoiceControl.append(diagnosticEntryLabel, addressTextElement, copyStateIndicator);
      sourceChoiceControl.addEventListener("click", async interactionEvent => {
        interactionEvent.preventDefault();
        interactionEvent.stopImmediatePropagation();
        if (openedDropdown.copying) return;
        openedDropdown.copying = true;
        sourceChoiceControl.disabled = true;
        try {
          await copyAddressToClipboard(sourceChoiceDescriptor.url);
          if (VideoSourceDropdown.visibleDropdown !== openedDropdown) return;
          for (const previousFocusedElement of openedDropdown.list.querySelectorAll("[data-copied]")) {
            previousFocusedElement.removeAttribute("data-copied");
            previousFocusedElement.querySelector(".ujs-video-link-copy").textContent = "复制";
          }
          sourceChoiceControl.dataset.copied = "true";
          copyStateIndicator.textContent = "已复制";
          openedDropdown.manual.hidden = true;
          openedDropdown.status.dataset.state = "success";
          openedDropdown.status.textContent = "已复制：" + sourceChoiceDescriptor.label;
          downloadDiagnostics.info(downloadTaskKey, "视频地址已复制到剪贴板", {
            format: sourceChoiceDescriptor.format,
            url: downloadDiagnostics.url(sourceChoiceDescriptor.url)
          });
          VideoSourceDropdown.dismissSourceList(true);
        } catch (failureCause) {
          if (VideoSourceDropdown.visibleDropdown !== openedDropdown) return;
          openedDropdown.status.dataset.state = "error";
          openedDropdown.status.textContent = "自动复制失败，请在下方按 Ctrl+C 手动复制。";
          openedDropdown.manual.value = sourceChoiceDescriptor.url;
          openedDropdown.manual.hidden = false;
          openedDropdown.manual.focus({
            preventScroll: true
          });
          openedDropdown.manual.select();
          downloadDiagnostics.error(downloadTaskKey, "复制视频地址失败", downloadDiagnostics.errorDetails(failureCause));
        } finally {
          openedDropdown.copying = false;
          sourceChoiceControl.disabled = false;
          if (VideoSourceDropdown.visibleDropdown === openedDropdown) VideoSourceDropdown.alignSourceList(openedDropdown);
        }
      });
      openedDropdown.list.append(sourceChoiceControl);
    }
  }
  class DownloadControls {
    static activeVideoDownloads = new Map();
    static attachVideoDownload(downloadControl, postIdentifier, videoSequencePosition = 0) {
      if (!postIdentifier || downloadControl.dataset.isMultiMedia) return;
      const mediaIdentity = downloadControl.dataset.url ? stripAddressQuery(downloadControl.dataset.url) : `video:${videoSequencePosition}`;
      downloadControl.dataset.videoTaskKey = `${postIdentifier}:${mediaIdentity}`;
      const activeDownload = DownloadControls.activeVideoDownloads.get(downloadControl.dataset.videoTaskKey);
      if (activeDownload) {
        activeDownload.controls.add(downloadControl);
        DownloadControls.syncVideoDownload(downloadControl);
      }
    }
    static syncVideoDownload(downloadControl, completed = false) {
      const taskKey = downloadControl.dataset.videoTaskKey;
      const activeDownload = DownloadControls.activeVideoDownloads.get(taskKey);
      if (!activeDownload) return;
      const sourceControl = activeDownload.source;
      const sourceProgress = sourceControl.querySelector(".ujs-progress");
      const sourceFailure = sourceControl.querySelector(".ujs-btn-error-text");
      const stateClasses = ["ujs-downloading", "ujs-error", "ujs-downloaded", "ujs-already-downloaded", "ujs-recently-downloaded"];
      for (const currentControl of activeDownload.controls) {
        if (currentControl === sourceControl) continue;
        if (!currentControl.isConnected) {
          activeDownload.controls.delete(currentControl);
          continue;
        }
        currentControl.title = sourceControl.title;
        currentControl.dataset.downloadTaskId = sourceControl.dataset.downloadTaskId;
        for (const stateClass of stateClasses) {
          currentControl.classList.toggle(stateClass, sourceControl.classList.contains(stateClass));
        }
        const currentProgress = currentControl.querySelector(".ujs-progress");
        currentProgress.style.cssText = sourceProgress.style.cssText;
        for (const field of ["downloaded", "total"]) {
          if (sourceProgress.dataset[field] === undefined) delete currentProgress.dataset[field];
          else currentProgress.dataset[field] = sourceProgress.dataset[field];
        }
        const currentFailure = currentControl.querySelector(".ujs-btn-error-text");
        currentFailure.textContent = sourceFailure.textContent;
        currentFailure.style.cssText = sourceFailure.style.cssText;
      }
      if (completed) DownloadControls.activeVideoDownloads.delete(taskKey);
    }
    static markControlFailure({
      btn: downloadControl,
      err: caughtFailure,
      text: displayText = ""
    } = {}) {
      if (traceEnabled) {
        console.error(caughtFailure);
      }
      const controlFailureIndicator = downloadControl.querySelector(".ujs-btn-error-text");
      downloadControl.classList.remove("ujs-downloading");
      downloadControl.classList.add("ujs-error");
      controlFailureIndicator.textContent = "";
      controlFailureIndicator.style = failureIndicatorStyle;
      let displayTitle = caughtFailure.message;
      if (displayText) {
        displayTitle = displayText + "\n" + caughtFailure.message;
      }
      if (displayTitle.includes("{ffHint}")) {
        displayTitle = displayTitle.replace("{ffHint}", DownloadControls.describeFirefoxRecovery());
      }
      downloadControl.title = displayTitle;
      caughtFailure.message = displayTitle;
      DownloadControls.syncVideoDownload(downloadControl, true);
      downloadDiagnostics.error(downloadControl.dataset.downloadTaskId, "操作失败", downloadDiagnostics.errorDetails(caughtFailure));
      return caughtFailure;
    }
    static markControlWarning({
      btn: downloadControl,
      text: displayText = ""
    } = {}) {
      const controlFailureIndicator = downloadControl.querySelector(".ujs-btn-error-text");
      downloadControl.classList.add("ujs-error");
      controlFailureIndicator.textContent = "";
      controlFailureIndicator.style = warningIndicatorStyle;
      downloadControl.title = "[warning] " + displayText;
    }
    static describeFirefoxRecovery() {
      const shouldSuggestFirefoxRecovery = (firefoxBrowserDetected || firefoxSandboxDetected) && !runtimePreferences.strictTrackingProtectionFix;
      const firefoxRecoveryMessage = shouldSuggestFirefoxRecovery ? "\nTry to enable 'Strict Tracking Protection Fix' in the userscript settings." : "";
      return firefoxRecoveryMessage;
    }
    static clearControlFailure(downloadControl) {
      const controlFailureIndicator = downloadControl.querySelector(".ujs-btn-error-text");
      if (downloadControl.textContent !== "") {
        controlFailureIndicator.textContent = "";
      }
      downloadControl.classList.remove("ujs-error");
    }
    static markHistoricalSave(downloadControl) {
      downloadControl.classList.add("ujs-already-downloaded");
    }
    static markTransferActive(downloadControl) {
      downloadControl.classList.add("ujs-downloading");
      const taskKey = downloadControl.dataset.videoTaskKey;
      if (taskKey && !DownloadControls.activeVideoDownloads.has(taskKey)) {
        DownloadControls.activeVideoDownloads.set(taskKey, {source: downloadControl, controls: new Set([downloadControl])});
      }
      DownloadControls.syncVideoDownload(downloadControl);
    }
    static markConnectionPending(downloadControl) {
      downloadControl.title = "Downloading... (waiting for connection)";
      DownloadControls.syncVideoDownload(downloadControl);
    }
    static findInteractionControl(interactionEvent) {
      const downloadControl = interactionEvent.currentTarget;
      if (!downloadControl.classList.contains("ujs-btn-download")) {
        if (traceEnabled) {
          console.error("[ujs][warning] Download button element not found");
        }
        throw new Error("Download button element not found");
      }
      return downloadControl;
    }
    static createControlProgressReporter(downloadControl) {
      const controlProgressIndicator = downloadControl.querySelector(".ujs-progress");
      const notifyTransferProgress = ({
        loaded: transferredByteCount,
        total: expectedTotalCount,
        progress: completionRatio
      }) => {
        const completedPortion = Number.isFinite(completionRatio) ? completionRatio : expectedTotalCount > 0 ? transferredByteCount / expectedTotalCount : 0;
        controlProgressIndicator.style.cssText = "--progress: " + Math.max(0, Math.min(1, completedPortion)) * 90 + "%";
        controlProgressIndicator.dataset.downloaded = transferredByteCount;
        controlProgressIndicator.dataset.total = expectedTotalCount;
        if (Number.isFinite(completionRatio)) {
          downloadControl.title = `Downloading: ${Math.floor(completedPortion * 100)}% (${formatReadableByteCount(transferredByteCount)})`;
        } else if (!expectedTotalCount) {
          downloadControl.title = `Downloading: ${formatReadableByteCount(transferredByteCount)}`;
        } else {
          downloadControl.title = `Downloading: ${formatReadableByteCount(transferredByteCount)} / ${formatReadableByteCount(expectedTotalCount)}`;
        }
        DownloadControls.syncVideoDownload(downloadControl);
      };
      return notifyTransferProgress;
    }
    static showCompletedProgress(downloadControl) {
      const controlProgressIndicator = downloadControl.querySelector(".ujs-progress");
      controlProgressIndicator.style.cssText = "--progress: 100%";
      if (downloadControl.title.startsWith("Downloading:")) {
        downloadControl.title = `Downloaded: ${formatReadableByteCount(Number(controlProgressIndicator.dataset.downloaded))}`;
      }
      DownloadControls.syncVideoDownload(downloadControl);
    }
    static clearControlProgress(downloadControl) {
      const controlProgressIndicator = downloadControl.querySelector(".ujs-progress");
      controlProgressIndicator.style.cssText = "--progress: 0%";
      DownloadControls.syncVideoDownload(downloadControl);
    }
    static clearCollectionProgress(downloadControl) {
      const collectionProgressIndicator = downloadControl.querySelector(".ujs-media-progress");
      collectionProgressIndicator.style.cssText = "--media-progress: 0%";
    }
    static updateCollectionProgress(downloadControl, previouslySaved, expectedTotalCount) {
      const collectionProgressIndicator = downloadControl.querySelector(".ujs-media-progress");
      collectionProgressIndicator.style.cssText = "--media-progress: " + Math.min(100, previouslySaved / expectedTotalCount * 100 + 10) + "%";
    }
    static controlHasSavedState(downloadControl) {
      return downloadControl.classList.contains("ujs-already-downloaded") || downloadControl.classList.contains("ujs-downloaded");
    }
    static clearSavedControlState(downloadControl) {
      downloadControl.classList.remove("ujs-downloaded");
      downloadControl.classList.remove("ujs-recently-downloaded");
    }
    static showSavedControlState(downloadControl) {
      downloadControl.classList.remove("ujs-downloading");
      downloadControl.classList.remove("ujs-recently-downloaded");
      downloadControl.classList.add("ujs-downloaded");
      DownloadControls.syncVideoDownload(downloadControl, true);
      downloadControl.addEventListener("pointerenter", pointerEnterEvent => {
        downloadControl.classList.add("ujs-recently-downloaded");
      }, {
        once: true
      });
    }
    static buildDownloadControl({
      url: resourceAddress,
      downloaded: previouslySaved,
      isVideo: isVideoControl,
      isThumb: isThumbnailControl,
      isMultiMedia: isMediaCollection
    }) {
      const downloadControl = document.createElement("div");
      downloadControl.innerHTML = `
<div class="ujs-btn-common ujs-btn-background">
  <div class="ujs-dot ujs-multimedia-icon ujs-media-progress" style="--media-progress: 0%"></div>
  <div class="ujs-dot ujs-multimedia-icon ujs-back"></div>
</div>
<div class="ujs-btn-common ujs-hover"></div>
<div class="ujs-btn-common ujs-shadow"></div>
<div class="ujs-btn-common ujs-progress" style="--progress: 0%"></div>
<div class="ujs-btn-common ujs-btn-error-text"></div>`.trimStart();
      downloadControl.classList.add("ujs-btn-download");
      if (!previouslySaved) {
        downloadControl.classList.add("ujs-not-downloaded");
      } else {
        downloadControl.classList.add("ujs-already-downloaded");
      }
      if (isVideoControl) {
        downloadControl.classList.add("ujs-video");
      }
      if (isVideoControl || isMediaCollection) {
        downloadControl.title = "点击下载";
        VideoSourceDropdown.mountSourceToggle(downloadControl);
      }
      if (resourceAddress) {
        downloadControl.dataset.url = resourceAddress;
      }
      if (isThumbnailControl) {
        downloadControl.dataset.thumb = "true";
      }
      if (isMediaCollection) {
        downloadControl.dataset.isMultiMedia = "true";
      }
      return downloadControl;
    }
  }
  class ImageSaveRegistry {
    static extractImageStorageName(resourceAddress) {
      const normalizedResourceLocation = new URL(resourceAddress);
      const {
        filename: outputBasename
      } = (normalizedResourceLocation.origin + normalizedResourceLocation.pathname).match(/(?<filename>[^\/]+$)/).groups;
      return outputBasename.match(/^[^.]+/)[0];
    }
    static containsImageSave({
      id: postIdentifier,
      url: resourceAddress
    }) {
      if (imageHistoryStrategy === "TWEET_ID") {
        return savedImagePostKeys.hasItem(postIdentifier);
      } else if (imageHistoryStrategy === "IMAGE_NAME") {
        const entryName = ImageSaveRegistry.extractImageStorageName(resourceAddress);
        return savedImageNames.hasItem(entryName);
      }
    }
    static async recordImageSave({
      id: postIdentifier,
      url: resourceAddress
    }) {
      if (imageHistoryStrategy === "TWEET_ID") {
        await savedImagePostKeys.pushItem(postIdentifier);
      } else if (imageHistoryStrategy === "IMAGE_NAME") {
        const entryName = ImageSaveRegistry.extractImageStorageName(resourceAddress);
        await savedImageNames.pushItem(entryName);
      }
    }
  }
  class VideoSaveRegistry {
    static composeVideoStorageKey(referencedPostKey, videoSequencePosition) {
      return videoSequencePosition ? referencedPostKey + "-" + videoSequencePosition : referencedPostKey;
    }
    static containsVideoSave({
      tweetId: referencedPostKey,
      videoIndex: videoSequencePosition = 0
    } = {}) {
      return savedVideoPostKeys.hasItem(this.composeVideoStorageKey(referencedPostKey, videoSequencePosition));
    }
    static async recordVideoSave({
      tweetId: referencedPostKey,
      videoIndex: videoSequencePosition
    }) {
      await savedVideoPostKeys.pushItem(this.composeVideoStorageKey(referencedPostKey, videoSequencePosition));
    }
  }
  function locateMediaControlHost(imageElement) {
    let mediaContainerElement = imageElement.closest("a");
    if (!mediaContainerElement) {
      traceEnabled && console.log(`[ujs][getImgParentElem] No parent "expanded_url" link`, imageElement);
      mediaContainerElement = imageElement.parentElement;
    }
    return mediaContainerElement;
  }
  function isProfileMediaThumbnail(imageElement) {
    const mediaListEntry = imageElement.closest(`li[role="listitem"]`);
    return Boolean(mediaListEntry);
  }
  async function shouldIgnoreSmallImage(imageElement) {
    if (imageElement.src === "https://pbs.twimg.com/media/GxJIrSUagAAK-ZP?format=jpg&name=240x240") {
      return true;
    }
    if (imageElement.width === 0) {
      const imageReadyPromise = new Promise(async fulfillPendingPromise => {
        imageElement.onload = fulfillPendingPromise;
      });
      await Promise.any([imageReadyPromise, waitForMilliseconds(500)]);
      await waitForMilliseconds(10);
    }
    return imageElement.width < 140;
  }
  class MediaActions {
    static async scanImageElements() {
      traceEnabled && console.log("[ujs][imagesHandler]");
      const visibleImageElements = document.querySelectorAll(`img:not([data-handled]):not([src$=".svg"])`);
      for (const imageElement of visibleImageElements) {
        imageElement.dataset.handled = "true";
      }
      for (const imageElement of visibleImageElements) {
        if (await shouldIgnoreSmallImage(imageElement)) {
          continue;
        }
        traceEnabled && console.log("[ujs][imagesHandler]", {
          img: imageElement,
          img_width: imageElement.width
        });
        const mediaContainerElement = locateMediaControlHost(imageElement);
        const isThumbnailControl = isProfileMediaThumbnail(imageElement);
        const isVideoThumbnail = MediaActions.recognizeVideoPoster(imageElement);
        if (isThumbnailControl && mediaContainerElement.querySelector("svg")) {
          MediaActions.decorateMediaCollection(imageElement, isThumbnailControl, mediaContainerElement, isVideoThumbnail);
          continue;
        }
        const isVideoPreviewImage = isVideoThumbnail || MediaActions.recognizeVideoContext(imageElement);
        if (isVideoPreviewImage) {
          MediaActions.decorateVideoPoster(imageElement, isThumbnailControl, mediaContainerElement);
          continue;
        }
        MediaActions.decorateImageElement(imageElement, isThumbnailControl, mediaContainerElement);
      }
    }
    static decorateImageElement(imageElement, isThumbnailControl, controlMountPoint) {
      const downloadControl = DownloadControls.buildDownloadControl({
        url: imageElement.src,
        isThumb: isThumbnailControl
      });
      downloadControl.addEventListener("click", MediaActions.handleImageSaveClick);
      controlMountPoint.append(downloadControl);
      const previouslySaved = ImageSaveRegistry.containsImageSave({
        id: PostContext.fromDescendant(downloadControl).id,
        url: downloadControl.dataset.url
      });
      if (previouslySaved) {
        DownloadControls.markHistoricalSave(downloadControl);
      }
      void waitForMilliseconds(50).then(() => {
        if (location.href.includes("/status/")) {
          const controlBounds = downloadControl.getBoundingClientRect();
          if (controlBounds.x < 55 && controlBounds.y < 55) {
            downloadControl.style.marginLeft = "2.5%";
            downloadControl.style.marginTop = "0.5%";
          }
        }
      });
    }
    static recognizeVideoPoster(imageElement) {
      const resolvedResult = imageElement.src.includes("ext_tw_video_thumb") || imageElement.src.includes("amplify_video_thumb") || imageElement.src.includes("tweet_video_thumb");
      return resolvedResult;
    }
    static recognizeVideoContext(imageElement) {
      const resolvedResult = imageElement.alt === "Animated Text GIF" || imageElement.alt === "Embedded video" || imageElement.closest(`a[aria-label="Embedded video"]`);
      traceEnabled && console.log("[ujs][_isVideoTweet]", resolvedResult, imageElement);
      return resolvedResult;
    }
    static posterSequenceByPost = new WeakMap();
    static playerSequenceByPost = new WeakMap();
    static async scanVideoPlayers() {
      const videoDescriptors = document.querySelectorAll("video:not([data-handled])");
      for (const videoElement of videoDescriptors) {
        if (videoElement.dataset.handled) {
          continue;
        }
        videoElement.dataset.handled = "true";
        traceEnabled && console.log("[ujs][videoHandler][video]", videoElement);
        const posterAddress = videoElement.getAttribute("poster");
        const downloadControl = DownloadControls.buildDownloadControl({
          url: posterAddress,
          isVideo: true
        });
        downloadControl.addEventListener("click", MediaActions.handleVideoSaveClick);
        const videoPlayerContainer = videoElement.closest(`[data-testid="videoComponent"]`);
        if (videoPlayerContainer) {
          videoPlayerContainer.parentElement.append(downloadControl);
        } else {
          videoElement.parentElement.parentElement.parentElement.after(downloadControl);
        }
        const resolvedPostContext = PostContext.fromDescendant(downloadControl);
        const referencedPostKey = resolvedPostContext.id;
        const postContainerElement = resolvedPostContext.elem;
        let videoSequencePosition = 0;
        if (postContainerElement) {
          const lookupTable = MediaActions.playerSequenceByPost;
          if (lookupTable.has(postContainerElement)) {
            videoSequencePosition = lookupTable.get(postContainerElement) + 1;
            lookupTable.set(postContainerElement, videoSequencePosition);
          } else {
            lookupTable.set(postContainerElement, videoSequencePosition);
          }
        } else {
          await waitForMilliseconds(10);
          const matchedEntry = location.pathname.match(/(?<=\/video\/)\d/);
          if (!matchedEntry) {
            traceEnabled && console.log("[ujs][videoHandler] missed match for match");
          }
          videoSequencePosition = Number(matchedEntry[0]) - 1;
          console.warn("[ujs][videoHandler] videoIndex", videoSequencePosition);
        }
        const previouslySaved = VideoSaveRegistry.containsVideoSave({
          tweetId: referencedPostKey,
          videoIndex: videoSequencePosition
        });
        if (previouslySaved) {
          DownloadControls.markHistoricalSave(downloadControl);
        }
        DownloadControls.attachVideoDownload(downloadControl, referencedPostKey, videoSequencePosition);
      }
    }
    static decorateVideoPoster(posterImageElement, isThumbnailControl, controlMountPoint) {
      traceEnabled && console.log("[ujs][_thumbVideoHandler][vid]", posterImageElement);
      const downloadControl = DownloadControls.buildDownloadControl({
        url: posterImageElement.src,
        isVideo: true,
        isThumb: isThumbnailControl
      });
      downloadControl.addEventListener("click", MediaActions.handleVideoSaveClick);
      controlMountPoint.append(downloadControl);
      const resolvedPostContext = PostContext.fromDescendant(downloadControl);
      const referencedPostKey = resolvedPostContext.id;
      const postContainerElement = resolvedPostContext.elem || downloadControl.closest(`[data-testid="tweet"]`);
      let videoSequencePosition = 0;
      if (postContainerElement) {
        const lookupTable = MediaActions.posterSequenceByPost;
        if (lookupTable.has(postContainerElement)) {
          videoSequencePosition = lookupTable.get(postContainerElement) + 1;
          lookupTable.set(postContainerElement, videoSequencePosition);
        } else {
          lookupTable.set(postContainerElement, videoSequencePosition);
        }
      }
      const previouslySaved = VideoSaveRegistry.containsVideoSave({
        tweetId: referencedPostKey,
        videoIndex: videoSequencePosition
      });
      if (previouslySaved) {
        DownloadControls.markHistoricalSave(downloadControl);
      }
      DownloadControls.attachVideoDownload(downloadControl, referencedPostKey, videoSequencePosition);
    }
    static decorateMediaCollection(posterImageElement, isThumbnailControl, controlMountPoint, isVideoControl) {
      traceEnabled && console.log("[ujs][_multiMediaThumbHandler]", posterImageElement);
      const downloadControl = DownloadControls.buildDownloadControl({
        url: posterImageElement.src,
        isVideo: isVideoControl,
        isThumb: isThumbnailControl,
        isMultiMedia: true
      });
      downloadControl.addEventListener("click", MediaActions.handleCollectionSaveClick);
      controlMountPoint.append(downloadControl);
      let previouslySaved;
      const referencedPostKey = PostContext.fromDescendant(downloadControl).id;
      if (isVideoControl) {
        previouslySaved = VideoSaveRegistry.containsVideoSave({
          tweetId: referencedPostKey
        });
      } else {
        previouslySaved = ImageSaveRegistry.containsImageSave({
          id: referencedPostKey,
          url: downloadControl.dataset.url
        });
      }
      if (previouslySaved) {
        DownloadControls.markHistoricalSave(downloadControl);
      }
    }
    static async handleImageSaveClick(interactionEvent) {
      interactionEvent.preventDefault();
      interactionEvent.stopImmediatePropagation();
      const downloadControl = DownloadControls.findInteractionControl(interactionEvent);
      let resourceAddress = downloadControl.dataset.url;
      const isProfileBackdrop = resourceAddress.includes("/profile_banners/");
      if (isProfileBackdrop) {
        return MediaActions.saveProfileBackdrop(resourceAddress, downloadControl);
      }
      const {
        id: postIdentifier,
        author: creatorHandle
      } = PostContext.fromDescendant(downloadControl);
      traceEnabled && console.log("[ujs][_imageClickHandler]", {
        id: postIdentifier,
        author: creatorHandle
      });
      try {
        await MediaActions.saveImageDescriptor(postIdentifier, creatorHandle, resourceAddress, downloadControl);
      } catch (caughtFailure) {
        throw DownloadControls.markControlFailure({
          btn: downloadControl,
          err: caughtFailure,
          text: "Failed to download the image."
        });
      }
    }
    static async saveProfileBackdrop(resourceAddress, downloadControl) {
      DownloadControls.markTransferActive(downloadControl);
      const {
        blob: downloadPayload,
        lastModifiedDate: resourceModifiedDate,
        extension: outputFileSuffix,
        name: entryName
      } = await requestMediaBlob(resourceAddress);
      MediaActions.validatePayloadPresence(downloadPayload, resourceAddress);
      const profileHandle = location.pathname.slice(1).split("/")[0];
      const {
        id: postIdentifier,
        seconds: backdropVersionSeconds,
        res: backdropResourceData
      } = resourceAddress.match(/(?<=\/profile_banners\/)(?<id>\d+)\/(?<seconds>\d+)\/(?<res>\d+x\d+)/)?.groups || {};
      const outputBasename = fillFilenamePattern(profileBackdropNamePattern, {
        username: profileHandle,
        lastModifiedDate: resourceModifiedDate,
        id: postIdentifier,
        seconds: backdropVersionSeconds,
        extension: outputFileSuffix
      }).value;
      savePayloadToDevice(downloadPayload, outputBasename, resourceAddress);
      DownloadControls.showSavedControlState(downloadControl);
    }
    static async saveImageDescriptor(postIdentifier, creatorHandle, resourceAddress, downloadControl) {
      DownloadControls.clearControlFailure(downloadControl);
      DownloadControls.markTransferActive(downloadControl);
      const notifyTransferProgress = DownloadControls.createControlProgressReporter(downloadControl);
      const originalImageSizes = ["orig", "4096x4096"];
      const reducedImageSizes = ["large", "medium", "900x900", "small", "360x360"];
      let isReducedImageFallback = false;
      const previewSizeToken = new URL(resourceAddress).searchParams.get("name");
      if (!reducedImageSizes.includes(previewSizeToken)) {
        reducedImageSizes.push(previewSizeToken);
      }
      function chooseImageFallbackAddress(resourceAddress) {
        const parsedResourceAddress = new URL(resourceAddress);
        if (originalImageSizes.length) {
          parsedResourceAddress.searchParams.set("name", originalImageSizes.shift());
        } else if (reducedImageSizes.length) {
          isReducedImageFallback = true;
          parsedResourceAddress.searchParams.set("name", reducedImageSizes.shift());
        } else {
          throw new Error("All fallback URLs are failed to download.");
        }
        if (parsedResourceAddress.searchParams.get("format") === "webp") {
          parsedResourceAddress.searchParams.set("format", "jpg");
        }
        const imageRequestAddress = parsedResourceAddress.toString();
        traceEnabled && console.log("[ujs][handleImgUrl][url]", imageRequestAddress);
        return imageRequestAddress;
      }
      let selectedResourceAddress = resourceAddress;
      async function fetchImageWithFallbacks(imageRequestAddress) {
        while (true) {
          const nextImageAddress = chooseImageFallbackAddress(imageRequestAddress);
          selectedResourceAddress = nextImageAddress;
          try {
            const resolvedResult = await requestMediaBlob(nextImageAddress, notifyTransferProgress);
            const operationStatus = resolvedResult.status.toString();
            if (!operationStatus.startsWith("2")) {
              const parsedResourceAddress = new URL(nextImageAddress);
              const imageQueryParameters = parsedResourceAddress.searchParams;
              if (imageQueryParameters.get("name") === "orig" && imageQueryParameters.get("format") === "jpg") {
                imageQueryParameters.set("format", "png");
                const alternatePngAddress = parsedResourceAddress.toString();
                const resolvedResult = await requestMediaBlob(alternatePngAddress, notifyTransferProgress);
                if (resolvedResult.status === 404) {
                  throw new Error("404");
                }
                return resolvedResult;
              }
            }
            return resolvedResult;
          } catch (caughtFailure) {
            if (!originalImageSizes.length) {
              DownloadControls.markControlWarning({
                btn: downloadControl,
                text: "Original images are not available."
              });
            }
            if (!reducedImageSizes.length) {
              throw DownloadControls.markControlFailure({
                btn: downloadControl,
                err: caughtFailure,
                text: "All fallback URLs are failed.{ffHint}"
              });
            }
          }
        }
      }
      DownloadControls.markConnectionPending(downloadControl);
      const {
        blob: downloadPayload,
        lastModifiedDate: resourceModifiedDate,
        extension: outputFileSuffix,
        name: entryName
      } = await fetchImageWithFallbacks(selectedResourceAddress);
      MediaActions.validatePayloadPresence(downloadPayload, selectedResourceAddress);
      DownloadControls.showCompletedProgress(downloadControl);
      const reducedImageFilenameMarker = isReducedImageFallback ? "[sample]" : "";
      const outputBasename = fillFilenamePattern(imageOutputNamePattern, {
        author: creatorHandle,
        lastModifiedDate: resourceModifiedDate,
        tweetId: postIdentifier,
        name: entryName,
        extension: outputFileSuffix,
        sampleText: reducedImageFilenameMarker
      }).value;
      savePayloadToDevice(downloadPayload, outputBasename, selectedResourceAddress);
      const previouslySaved = DownloadControls.controlHasSavedState(downloadControl);
      if (!previouslySaved && !isReducedImageFallback) {
        await ImageSaveRegistry.recordImageSave({
          id: postIdentifier,
          url: selectedResourceAddress
        });
      }
      if (downloadControl.dataset.isMultiMedia && !isReducedImageFallback) {
        const hasSavedRecord = ImageSaveRegistry.containsImageSave({
          id: postIdentifier,
          url: selectedResourceAddress
        });
        if (!hasSavedRecord) {
          await ImageSaveRegistry.recordImageSave({
            id: postIdentifier,
            url: selectedResourceAddress
          });
        }
      }
      await waitForMilliseconds(125);
      DownloadControls.clearControlProgress(downloadControl);
      DownloadControls.showSavedControlState(downloadControl);
    }
    static async handleCollectionSaveClick(interactionEvent) {
      interactionEvent.preventDefault();
      interactionEvent.stopImmediatePropagation();
      const downloadControl = DownloadControls.findInteractionControl(interactionEvent);
      if (downloadControl.classList.contains("ujs-downloading")) {
        downloadDiagnostics.warn(downloadControl.dataset.downloadTaskId, "忽略重复点击，下载仍在进行");
        return;
      }
      const downloadTaskKey = downloadControl.dataset.downloadTaskId = downloadDiagnostics.start({
        type: "multimedia"
      });
      DownloadControls.clearControlFailure(downloadControl);
      DownloadControls.markTransferActive(downloadControl);
      const {
        id: postIdentifier
      } = PostContext.fromDescendant(downloadControl);
      let mediaDescriptors;
      try {
        mediaDescriptors = await PostService.readPostMediaDescriptors(postIdentifier, downloadTaskKey);
        mediaDescriptors = mediaDescriptors.filter(selectedMediaDescriptor => selectedMediaDescriptor.tweet_id === postIdentifier);
      } catch (caughtFailure) {
        throw DownloadControls.markControlFailure({
          btn: downloadControl,
          err: caughtFailure,
          text: "API.getTweetMedias failed.{ffHint}"
        });
      }
      if (interactionEvent.shiftKey) {
        MediaActions.printVideoSourceAddresses(mediaDescriptors.filter(mediaDescriptor => mediaDescriptor.type === "video"), downloadControl, downloadTaskKey);
        return;
      }
      DownloadControls.clearCollectionProgress(downloadControl);
      const expectedTotalCount = mediaDescriptors.length;
      let previouslySaved = 0;
      for (const selectedMediaDescriptor of mediaDescriptors) {
        DownloadControls.clearSavedControlState(downloadControl);
        if (selectedMediaDescriptor.type === "video") {
          try {
            await MediaActions.saveVideoDescriptor(selectedMediaDescriptor, downloadControl, postIdentifier);
          } catch (caughtFailure) {
            throw DownloadControls.markControlFailure({
              btn: downloadControl,
              err: caughtFailure
            });
          }
        } else {
          const {
            screen_name: creatorHandle,
            download_url: resourceAddress,
            tweet_id: postIdentifier
          } = selectedMediaDescriptor;
          await MediaActions.saveImageDescriptor(postIdentifier, creatorHandle, resourceAddress, downloadControl);
        }
        previouslySaved++;
        DownloadControls.updateCollectionProgress(downloadControl, previouslySaved, expectedTotalCount);
        await waitForMilliseconds(50);
      }
      DownloadControls.showSavedControlState(downloadControl);
      downloadDiagnostics.info(downloadTaskKey, "批量下载流程结束，已触发浏览器保存", {
        count: previouslySaved
      });
    }
    static async handleVideoSaveClick(interactionEvent) {
      interactionEvent.preventDefault();
      interactionEvent.stopImmediatePropagation();
      const downloadControl = DownloadControls.findInteractionControl(interactionEvent);
      const {
        id: postIdentifier
      } = PostContext.fromDescendant(downloadControl);
      if (!downloadControl.dataset.videoTaskKey) DownloadControls.attachVideoDownload(downloadControl, postIdentifier);
      if (downloadControl.classList.contains("ujs-downloading")) {
        downloadDiagnostics.warn(downloadControl.dataset.downloadTaskId, "忽略重复点击，下载仍在进行");
        return;
      }
      const downloadTaskKey = downloadControl.dataset.downloadTaskId = downloadDiagnostics.start({
        type: "video",
        poster: downloadDiagnostics.url(downloadControl.dataset.url)
      });
      DownloadControls.clearControlFailure(downloadControl);
      DownloadControls.markTransferActive(downloadControl);
      let selectedMediaDescriptor;
      try {
        const mediaDescriptors = await PostService.readPostMediaDescriptors(postIdentifier, downloadTaskKey);
        const videoDescriptors = mediaDescriptors.filter(mediaDescriptor => mediaDescriptor.type === "video");
        selectedMediaDescriptor = MediaActions.selectMatchingVideo(mediaDescriptors, downloadControl.dataset.url);
        traceEnabled && console.log("[ujs][_videoClickHandler] mediaEntry", selectedMediaDescriptor);
        downloadDiagnostics.info(downloadTaskKey, "匹配视频媒体", {
          tweetId: postIdentifier,
          videoCount: videoDescriptors.length,
          matched: Boolean(selectedMediaDescriptor),
          mediaId: selectedMediaDescriptor?.media_id
        });
      } catch (caughtFailure) {
        throw DownloadControls.markControlFailure({
          btn: downloadControl,
          err: caughtFailure,
          text: "Video information request or parsing failed.{ffHint}"
        });
      }
      try {
        if (interactionEvent.shiftKey && selectedMediaDescriptor) {
          MediaActions.printVideoSourceAddresses([selectedMediaDescriptor], downloadControl, downloadTaskKey);
          return;
        }
        await MediaActions.saveVideoDescriptor(selectedMediaDescriptor, downloadControl, postIdentifier);
      } catch (caughtFailure) {
        throw DownloadControls.markControlFailure({
          btn: downloadControl,
          err: caughtFailure
        });
      }
      DownloadControls.showSavedControlState(downloadControl);
    }
    static selectMatchingVideo(mediaDescriptors, posterSourceAddress) {
      const videoDescriptors = mediaDescriptors.filter(mediaDescriptor => mediaDescriptor.type === "video");
      const posterAddress = posterSourceAddress ? stripAddressQuery(posterSourceAddress) : null;
      const matchedEntry = videoDescriptors.find(mediaDescriptor => mediaDescriptor.preview_url && posterAddress === stripAddressQuery(mediaDescriptor.preview_url));
      return matchedEntry || (videoDescriptors.length === 1 ? videoDescriptors[0] : undefined);
    }
    static printVideoSourceAddresses(mediaDescriptors, downloadControl, downloadTaskKey) {
      for (const mediaDescriptor of mediaDescriptors) {
        downloadDiagnostics.links(downloadTaskKey, mediaDescriptor, true);
      }
      if (!mediaDescriptors.length) {
        downloadDiagnostics.links(downloadTaskKey, {}, true);
      }
      downloadControl.classList.remove("ujs-downloading");
      downloadControl.title = "点击下载";
      DownloadControls.syncVideoDownload(downloadControl, true);
    }
    static async saveVideoDescriptor(selectedMediaDescriptor, downloadControl, postIdentifier) {
      if (!selectedMediaDescriptor) {
        throw new Error("Could not match this video to the tweet's media. Open the tweet and retry.");
      }
      const {
        screen_name: creatorHandle,
        tweet_id: videoSourcePostKey,
        type_index: videoSequencePosition
      } = selectedMediaDescriptor;
      const notifyTransferProgress = DownloadControls.createControlProgressReporter(downloadControl);
      const downloadTaskKey = downloadControl.dataset.downloadTaskId;
      DownloadControls.markConnectionPending(downloadControl);
      let requestedResource;
      try {
        requestedResource = await resolveAndFetchVideo(selectedMediaDescriptor, notifyTransferProgress, downloadTaskKey);
      } catch (caughtFailure) {
        caughtFailure.message = "Video download failed.{ffHint}\n" + caughtFailure.message;
        throw caughtFailure;
      }
      const {
        blob: downloadPayload,
        lastModifiedDate: resourceModifiedDate,
        extension: outputFileSuffix,
        name: entryName,
        url: resourceAddress
      } = requestedResource;
      MediaActions.validatePayloadPresence(downloadPayload, resourceAddress);
      downloadDiagnostics.info(downloadTaskKey, "视频文件已获取并通过校验", {
        sizeBytes: downloadPayload.size,
        type: downloadPayload.type
      });
      DownloadControls.showCompletedProgress(downloadControl);
      const outputBasename = fillFilenamePattern(videoOutputNamePattern, {
        author: creatorHandle,
        lastModifiedDate: resourceModifiedDate,
        tweetId: videoSourcePostKey,
        name: entryName,
        extension: outputFileSuffix
      }).value;
      savePayloadToDevice(downloadPayload, outputBasename, resourceAddress, downloadTaskKey);
      downloadDiagnostics.info(downloadTaskKey, "更新下载历史");
      const previouslySaved = DownloadControls.controlHasSavedState(downloadControl);
      if (!previouslySaved) {
        await VideoSaveRegistry.recordVideoSave({
          tweetId: videoSourcePostKey,
          videoIndex: videoSequencePosition
        });
        if (videoSourcePostKey !== postIdentifier) {
          await VideoSaveRegistry.recordVideoSave({
            tweetId: postIdentifier,
            videoIndex: videoSequencePosition
          });
        }
      }
      if (downloadControl.dataset.isMultiMedia) {
        const hasSavedRecord = VideoSaveRegistry.containsVideoSave({
          tweetId: videoSourcePostKey,
          videoIndex: videoSequencePosition
        });
        if (!hasSavedRecord) {
          await VideoSaveRegistry.recordVideoSave({
            tweetId: videoSourcePostKey,
            videoIndex: videoSequencePosition
          });
          if (videoSourcePostKey !== postIdentifier) {
            await VideoSaveRegistry.recordVideoSave({
              tweetId: postIdentifier,
              videoIndex: videoSequencePosition
            });
          }
        }
      }
      await waitForMilliseconds(125);
      DownloadControls.clearControlProgress(downloadControl);
      downloadDiagnostics.info(downloadTaskKey, "下载流程结束（浏览器保存已触发）", {
        filename: outputBasename,
        sizeBytes: downloadPayload.size
      });
    }
    static validatePayloadPresence(downloadPayload, resourceAddress) {
      if (!downloadPayload.size) {
        throw new Error("Zero size blob: " + resourceAddress);
      }
    }
    static installEnhancementStyles() {
      const stylesheetContent = composeEnhancementStyles();
      insertPageStyles(stylesheetContent);
    }
  }
  class PageEnhancements extends MediaActions {
    static refreshReadablePageTitle(displayTitle) {
      if (!localizedLabels.QUOTES) {
        return;
      }
      if (!location.href.match(/(twitter|x)\.com\/[^\/]+\/status\/\d+/)) {
        return;
      }
      let pageTitleText = displayTitle || document.title;
      if (pageTitleText === PageEnhancements.lastRenderedPageTitle) {
        return;
      }
      PageEnhancements.initialPageTitle = pageTitleText;
      const [TITLE_OPENING_MARK, TITLE_CLOSING_MARK] = localizedLabels.QUOTES;
      const titleShortAddresses = [...pageTitleText.matchAll(new RegExp(`https:\\/\\/t\\.co\\/[^ ${TITLE_CLOSING_MARK}]+`, "g"))].map(candidateEntry => candidateEntry[0]);
      const lookupTable = new Map();
      const hyperlinkElements = document.querySelectorAll(`a[data-redirect^="https://t.co/"]`);
      for (const hyperlinkElement of hyperlinkElements) {
        if (titleShortAddresses.includes(hyperlinkElement.dataset.redirect)) {
          lookupTable.set(hyperlinkElement.dataset.redirect, hyperlinkElement.href);
        }
      }
      const trailingShortAddress = titleShortAddresses.slice(-1)[0];
      let trailingAddressIsAttachment = false;
      let attachmentCaption = "";
      if (!lookupTable.has(trailingShortAddress)) {
        const attachmentAnchor = document.querySelector(`a[href="${trailingShortAddress}?amp=1"]`);
        if (attachmentAnchor) {
          trailingAddressIsAttachment = true;
          attachmentCaption = document.querySelectorAll(`a[href="${trailingShortAddress}?amp=1"]`)[1].innerText;
          attachmentCaption = attachmentCaption.replaceAll("\n", " — ");
        }
      }
      for (const [propertyName, entryContent] of lookupTable.entries()) {
        pageTitleText = pageTitleText.replaceAll(propertyName, entryContent + ` (${propertyName})`);
      }
      pageTitleText = pageTitleText.replace(new RegExp(`${localizedLabels.ON_TWITTER}(?= ${TITLE_OPENING_MARK})`), ":");
      pageTitleText = pageTitleText.replace(new RegExp(`(?<=${TITLE_CLOSING_MARK}) \\\/ ${localizedLabels.TWITTER}$`), "");
      if (!trailingAddressIsAttachment) {
        const matchingExpression = new RegExp(`(?<short> https:\\/\\/t\\.co\\/.{6,14})${TITLE_CLOSING_MARK}$`);
        pageTitleText = pageTitleText.replace(matchingExpression, (matchedEntry, shortAddressCapture, secondaryReplacementCapture, replacementOffset, replacementInputText) => `${TITLE_CLOSING_MARK} —${shortAddressCapture}`);
      } else {
        pageTitleText = pageTitleText.replace(trailingShortAddress, `${trailingShortAddress} (${attachmentCaption})`);
      }
      document.title = pageTitleText;
      PageEnhancements.lastRenderedPageTitle = document.title;
    }
    static lastRenderedPageTitle = "";
    static initialPageTitle = "";
    static resolvedProfileAddresses = new Map();
    static async resolveRedirectedLinks() {
      traceEnabled && console.log("[ujs][directLinks]");
      const hasWebProtocol = resourceAddress => Boolean(resourceAddress.match(/^https?:\/\//));
      const hyperlinkElements = findAllXpathNodes(`.//a[starts-with(@href, "https://t.co/") and @dir="ltr" and child::span and not(@data-handled)]`);
      for (const hyperlinkElement of hyperlinkElements) {
        const redirectAddress = new URL(hyperlinkElement.href);
        const normalizedShortAddress = redirectAddress.origin + redirectAddress.pathname;
        const originalHyperlinkAttribute = hyperlinkElement.getAttribute("href");
        traceEnabled && console.log("[ujs][directLinks]", {
          hrefAttr: originalHyperlinkAttribute,
          redirectUrl_href: redirectAddress.href,
          shortUrl: normalizedShortAddress
        });
        hyperlinkElement.dataset.redirect = normalizedShortAddress;
        hyperlinkElement.dataset.handled = "true";
        hyperlinkElement.rel = "nofollow noopener noreferrer";
        if (PageEnhancements.resolvedProfileAddresses.has(normalizedShortAddress)) {
          hyperlinkElement.href = PageEnhancements.resolvedProfileAddresses.get(normalizedShortAddress);
          continue;
        }
        const traversedNodes = findAllXpathNodes(`.//span[text() != "…"] | ./text()`, hyperlinkElement);
        let resourceAddress = traversedNodes.map(traversedNode => traversedNode.textContent).join("");
        const duplicatedProtocolMarker = resourceAddress.match(/(?<dup>^https?:\/\/)(?=https?:)/)?.groups.dup;
        if (duplicatedProtocolMarker) {
          resourceAddress = resourceAddress.slice(duplicatedProtocolMarker.length);
          const linkCaptionElement = hyperlinkElement.querySelector(`[aria-hidden="true"]`);
          if (hasWebProtocol(linkCaptionElement.textContent)) {
            linkCaptionElement.style = "display: none;";
          }
        }
        hyperlinkElement.href = resourceAddress;
        if (hyperlinkElement.dataset?.testid === "UserUrl") {
          const resolvedHyperlinkTarget = hyperlinkElement.getAttribute("href");
          const creatorProfileAddress = hasWebProtocol(resolvedHyperlinkTarget) ? resolvedHyperlinkTarget : "https://" + resolvedHyperlinkTarget;
          hyperlinkElement.href = creatorProfileAddress;
          traceEnabled && console.log("[ujs][directLinks][profileUrl]", creatorProfileAddress);
          if (hyperlinkElement.textContent.endsWith("…")) {
            hyperlinkElement.href = normalizedShortAddress;
            try {
              const creatorHandle = location.pathname.slice(1).match(/[^\/]+/)[0];
              const expandedPostAddress = await PostService.readProfileDestination(creatorHandle);
              hyperlinkElement.href = expandedPostAddress;
              PageEnhancements.resolvedProfileAddresses.set(normalizedShortAddress, expandedPostAddress);
            } catch (caughtFailure) {
              traceEnabled && console.error("[ujs]", caughtFailure);
            }
          }
        }
      }
      if (hyperlinkElements.length) {
        PageEnhancements.refreshReadablePageTitle(PageEnhancements.initialPageTitle);
      }
    }
    static revealAllowedSensitiveContent() {
      const primaryContentRegion = document.querySelector("main[role=main]");
      if (!primaryContentRegion) {
        return;
      }
      if (!localizedLabels.YES_VIEW_PROFILE) {
        return;
      }
      const primaryActionCandidates = primaryContentRegion.querySelectorAll("[data-testid=primaryColumn] [role=button]");
      if (primaryActionCandidates) {
        const contentElements = [...primaryActionCandidates];
        const actionControl = contentElements.find(candidateEntry => candidateEntry.textContent === localizedLabels.YES_VIEW_PROFILE);
        if (actionControl) {
          actionControl.click();
        }
        const revealContentControl = contentElements.find(candidateEntry => candidateEntry.textContent === localizedLabels.SHOW_NUDITY);
        if (revealContentControl) {
          revealContentControl.click();
        }
      }
      const presentationActionCandidates = primaryContentRegion.querySelectorAll("article [role=presentation] div[role=button]");
      if (presentationActionCandidates) {
        const contentElements = [...presentationActionCandidates];
        const actionControls = contentElements.filter(candidateEntry => candidateEntry.textContent === localizedLabels.VIEW);
        if (actionControls.length) {
          actionControls.forEach(candidateEntry => candidateEntry.click());
        }
      }
    }
    static concealRegistrationPanel() {
      if (!localizedLabels.SIGNUP) {
        return;
      }
      const contentElement = document.querySelector(`section[aria-label="${localizedLabels.SIGNUP}"][role=region]`);
      if (contentElement) {
        contentElement.parentElement.classList.add("ujs-hidden");
      }
    }
    static concealRegistrationOverlay(suppressVideoAutoplay) {
      if (suppressVideoAutoplay) {
        insertPageStyles(`
                    #layers > div:nth-child(1) {
                        display: none;
                    }
                `);
      } else {
        insertPageStyles(`
                    #layers > div:nth-child(1) {
                        height: 1px;
                        opacity: 0;
                    }
                `);
      }
      insertPageStyles(`[data-testid="BottomBar"] {
                pointer-events: none;
            }`);
    }
    static concealTrendPanel() {
      if (!localizedLabels.TRENDS) {
        return;
      }
      insertPageStyles(`
                [aria-label="${localizedLabels.TRENDS}"]
                {
                    display: none;
                }
            `);
    }
    static styleVisitedDestinations() {
      if (runtimePreferences.highlightOnlySpecialVisitedLinks) {
        insertPageStyles(`
                    a[href^="http"]:visited {
                        color: darkorange !important;
                    }
                `);
        return;
      }
      insertPageStyles(`
                a:visited {
                    color: darkorange !important;
                }
            `);
    }
    static flattenMediaCarousel() {
      insertPageStyles(`
                [role="article"] [data-testid="ScrollSnap-List"] {
                  display: grid;
                  grid-template-columns: repeat(2, 1fr);
                  grid-auto-flow: row;
                  grid-auto-rows: minmax(180px, auto);
                  align-content: initial;
                  gap: 2px;
                }


                [role="article"] [data-testid="ScrollSnap-List"] > *:first-child:nth-last-child(odd):not(:nth-last-child(3)) {
                  grid-column: 1 / -1;
                }


                [role="article"] [data-testid="ScrollSnap-List"] > *:first-child:nth-last-child(3) {
                  grid-row: 1 / 3;
                  grid-column: 1 / 2;
                }

                [role="article"] [data-testid="ScrollSnap-List"] [data-testid="tweetPhoto"] > div {
                    position: absolute;
                    top:    0px;
                    bottom: 0px;
                    right:  0px;
                    left:   0px;
                }


                [role="article"] [data-testid="ScrollSnap-prevButtonWrapper"],
                [role="article"] [data-testid="ScrollSnap-nextButtonWrapper"] {
                    display: none !important;
                }


                [role="article"] [data-testid="ScrollSnap-List"][data-ujs-many] {
                    overflow-y: scroll;
                    overflow-x: hidden;
                    scrollbar-width: thin;
                    scrollbar-color: rgba(128, 128, 128, 0.7) transparent;
                    margin-left: 0 !important;
                    margin-right: 0 !important;
                    padding-left: 0 !important;
                    padding-right: 0 !important;
                }
                [role="article"] [data-testid="ScrollSnap-List"][data-ujs-many]::-webkit-scrollbar {
                    display: block;
                    width: 8px;
                    height: 8px;
                }
                [role="article"] [data-testid="ScrollSnap-List"][data-ujs-many]::-webkit-scrollbar-track {
                    background: transparent;
                }
                [role="article"] [data-testid="ScrollSnap-List"][data-ujs-many]::-webkit-scrollbar-thumb {
                    background: rgba(128, 128, 128, 0.7);
                    border-radius: 4px;
                }
`);
    }
    static tagMediaCollections() {
      const mediaCollectionElements = document.querySelectorAll("[role=\"article\"] [data-testid=\"ScrollSnap-List\"]");
      for (const sourceChoicesContainer of mediaCollectionElements) {
        const hasMultipleMedia = sourceChoicesContainer.children.length > 4;
        if (hasMultipleMedia !== sourceChoicesContainer.hasAttribute("data-ujs-many")) {
          sourceChoicesContainer.toggleAttribute("data-ujs-many", hasMultipleMedia);
        }
      }
    }
    static footerAlreadyRelocated = false;
    static relocateFooterNavigation() {
      let pageFooterElement = document.querySelector(`main[role=main] nav[aria-label=${localizedLabels.FOOTER}][role=navigation]`);
      const footerNavigationElement = document.querySelector("nav[aria-label=Primary][role=navigation]");
      if (pageFooterElement) {
        pageFooterElement = pageFooterElement.parentNode;
        const footerSeparator = pageFooterElement.previousSibling;
        if (PageEnhancements.footerAlreadyRelocated) {
          pageFooterElement.remove();
          footerSeparator.remove();
          return;
        }
        footerNavigationElement.append(footerSeparator);
        footerNavigationElement.append(pageFooterElement);
        pageFooterElement.classList.add("ujs-show-on-hover");
        footerSeparator.classList.add("ujs-show-on-hover");
        PageEnhancements.footerAlreadyRelocated = true;
      }
    }
    static concealAuthenticationPopup() {
      const observedPageRoot = document.querySelector("html");
      const mutationObserverConfiguration = {
        attributes: true
      };
      const pageMutationObserver = new MutationObserver(handleObservedMutations);
      pageMutationObserver.observe(observedPageRoot, mutationObserverConfiguration);
      function handleObservedMutations(observedMutations, originatingMutationObserver) {
        const pageRootElement = document.querySelector("html");
        traceEnabled && console.log("[ujs][hideLoginPopup][mutationList]", observedMutations);
        if (pageRootElement.style["overflow"] === "hidden") {
          pageRootElement.style["overflow"] = "";
          pageRootElement.style["overflow-y"] = "scroll";
          pageRootElement.style["margin-right"] = "";
        }
        const authenticationPopupElement = document.querySelector(`#layers div[data-testid="sheetDialog"]`);
        if (authenticationPopupElement) {
          authenticationPopupElement.closest(`div[role="dialog"]`).remove();
          traceEnabled && (document.title = "⚒" + document.title);
        }
      }
    }
    static redirectMobileHost() {
      if (location.href.startsWith("https://mobile.twitter.com/")) {
        location.href = location.href.replace("https://mobile.twitter.com/", "https://twitter.com/");
      }
    }
  }
  return PageEnhancements;
}
function measureSavedStorage() {
  const storageUsageSummary = {
    total: 0
  };
  for (const [entryName, storageEntryKey] of Object.entries(storageKeys)) {
    const serializedStorageEntry = localStorage.getItem(storageEntryKey);
    if (serializedStorageEntry) {
      try {
        const entryContent = JSON.parse(serializedStorageEntry);
        if (Array.isArray(entryContent)) {
          const measuredByteCount = new Set(entryContent).size;
          storageUsageSummary[entryName] = measuredByteCount;
          storageUsageSummary.total += measuredByteCount;
        }
      } catch (caughtFailure) {}
    }
  }
  return storageUsageSummary;
}
function composeEnhancementStyles() {
  const imageAccessibilityLabel = localizedLabels.IMAGE || "Image";
  const pageScrollbarWidth = window.innerWidth - document.body.offsetWidth;
  const pageStylesheetText = `
.ujs-modal-wrapper .ujs-modal-settings {
  color: black;
}
.ujs-hidden {
    display: none;
}
.ujs-no-scroll {
    overflow-y: hidden;
}
.ujs-scroll-initial {
    overflow-y: initial!important;
}
.ujs-scrollbar-width-margin-right {
    margin-right: ${pageScrollbarWidth}px;
}

.ujs-show-on-hover:hover {
    opacity: 1;
    transition: opacity 1s ease-out 0.1s;
}
.ujs-show-on-hover {
    opacity: 0;
    transition: opacity 0.5s ease-out;
}

:root {
    --ujs-shadow-1: linear-gradient(to top, rgba(0,0,0,0.15), rgba(0,0,0,0.05));
    --ujs-shadow-2: linear-gradient(to top, rgba(0,0,0,0.25), rgba(0,0,0,0.05));
    --ujs-shadow-3: linear-gradient(to top, rgba(0,0,0,0.45), rgba(0,0,0,0.15));
    --ujs-shadow-4: linear-gradient(to top, rgba(0,0,0,0.55), rgba(0,0,0,0.25));
    --ujs-red:   #e0245e;
    --ujs-blue:  #1da1f2;
    --ujs-green: #4caf50;
    --ujs-gray:  #c2cbd0;
    --ujs-error: white;
}

.ujs-progress {
  background-image: linear-gradient(to right, var(--ujs-green) var(--progress), transparent 0%);
}

.ujs-shadow {
  background-image: var(--ujs-shadow-1);
}
.ujs-btn-download:hover .ujs-hover {
  background-image: var(--ujs-shadow-2);
}
.ujs-btn-download.ujs-downloading .ujs-shadow {
  background-image: var(--ujs-shadow-3);
}
.ujs-btn-download:active .ujs-shadow {
  background-image: var(--ujs-shadow-4);
}

.ujs-btn-download.ujs-downloaded.ujs-recently-downloaded {
    opacity: 0;
}

li[role="listitem"]:hover .ujs-btn-download {
    opacity: 1;
}
article[role=article]:hover .ujs-btn-download {
    opacity: 1;
}
div[aria-label="${imageAccessibilityLabel}"]:hover .ujs-btn-download {
    opacity: 1;
}
.ujs-btn-download.ujs-downloaded {
    opacity: 1;
}
.ujs-btn-download.ujs-downloading {
    opacity: 1;
}
[data-testid="videoComponent"]:hover + .ujs-btn-download {
    opacity: 1;
}
[data-testid="videoComponent"] + .ujs-btn-download:hover {
    opacity: 1;
}

.ujs-btn-download {
  cursor: pointer;
  top: 0.5em;
  left: 0.5em;
  position: absolute;
  opacity: 0;
}
.ujs-has-video-links {
  z-index: 5;
}
.ujs-btn-download.ujs-links-open,
.ujs-btn-download:focus-within {
  opacity: 1 !important;
}
.ujs-video-links-toggle {
  all: unset;
  box-sizing: border-box;
  position: absolute;
  left: 41px;
  top: 0;
  width: 32px;
  height: 37px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #cfd9de;
  border-radius: 5px;
  background: #fff;
  color: #0f1419;
  font: 20px/1 system-ui, sans-serif;
  cursor: pointer;
}
.ujs-video-links-toggle:hover,
.ujs-video-links-toggle[aria-expanded="true"] {
  background: #e8f5fd;
  color: #006aab;
}
.ujs-video-links-menu {
  --ujs-link-bg: #fff;
  --ujs-link-fg: #0f1419;
  --ujs-link-muted: #536471;
  --ujs-link-border: #eff3f4;
  --ujs-link-hover: #f2f8fc;
  box-sizing: border-box;
  position: fixed;
  z-index: 2147483646;
  width: 380px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #cfd9de;
  border-radius: 12px;
  background: var(--ujs-link-bg);
  color: var(--ujs-link-fg);
  box-shadow: 0 8px 32px #0003;
  font: 14px/1.45 system-ui, sans-serif;
  text-align: left;
}
.ujs-video-links-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px 8px 14px;
  border-bottom: 1px solid var(--ujs-link-border);
}
.ujs-video-links-close,
.ujs-video-links-retry {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.ujs-video-links-close {
  width: 32px;
  height: 32px;
  font-size: 23px;
}
.ujs-video-links-retry {
  margin: 8px;
  padding: 8px 14px;
  background: var(--ujs-link-hover);
}
.ujs-video-links-list {
  min-height: 0;
  max-height: min(360px, 55vh);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.ujs-video-links-group {
  padding: 9px 14px 4px;
  color: var(--ujs-link-muted);
  font-size: 12px;
  font-weight: 600;
}
.ujs-video-link-item {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 10px;
  width: 100%;
  padding: 11px 14px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.ujs-video-link-item:hover,
.ujs-video-link-item[data-copied],
.ujs-video-links-close:hover {
  background: var(--ujs-link-hover);
}
.ujs-video-link-label {
  font-weight: 600;
}
.ujs-video-link-url {
  display: none;
  grid-column: 1 / -1;
  grid-row: 2;
  overflow: hidden;
  color: var(--ujs-link-muted);
  font: 11px/1.5 ui-monospace, monospace;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ujs-video-link-copy {
  grid-column: 2;
  grid-row: 1;
  align-self: center;
  color: #0078b8;
  font-size: 12px;
}
.ujs-video-links-status {
  padding: 10px 14px;
  border-top: 1px solid var(--ujs-link-border);
  color: var(--ujs-link-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.ujs-video-links-status[data-state="success"] {
  color: #168343;
}
.ujs-video-links-status[data-state="error"] {
  color: #d32945;
}
.ujs-video-links-manual:not([hidden]) {
  box-sizing: border-box;
  display: block;
  margin: 0 12px 12px;
  padding: 8px;
  border: 1px solid #cfd9de;
  border-radius: 5px;
  background: var(--ujs-link-bg);
  color: inherit;
  font: 12px/1.5 ui-monospace, monospace;
}
.ujs-video-links-toggle:focus-visible,
.ujs-video-links-menu button:focus-visible,
.ujs-video-links-menu input:focus-visible {
  outline: 2px solid #1d9bf0;
  outline-offset: -2px;
}
@media (prefers-color-scheme: dark) {
  .ujs-video-links-menu {
    --ujs-link-bg: #16181c;
    --ujs-link-fg: #eff3f4;
    --ujs-link-muted: #a5b1ba;
    --ujs-link-border: #30363d;
    --ujs-link-hover: #202d38;
    border-color: #536471;
  }
  .ujs-video-links-toggle {
    background: #16181c;
    color: #eff3f4;
    border-color: #536471;
  }
  .ujs-video-link-copy { color: #71c4ff; }
  .ujs-video-links-status[data-state="success"] { color: #6bd691; }
  .ujs-video-links-status[data-state="error"] { color: #ff879b; }
}
.ujs-btn-common {
  width: 33px;
  height: 33px;
  border-radius: 0.3em;
  top: 0;
  position: absolute;
  border: 1px solid var(--ujs-gray);
  ${runtimePreferences.addBorder ? "border: 2px solid white;" : "border-color: var(--ujs-gray);"}
}
.ujs-not-downloaded .ujs-btn-background {
  background: var(--ujs-red);
}

.ujs-already-downloaded .ujs-btn-background {
  background: var(--ujs-blue);
}

.ujs-btn-done {
  box-shadow: 0 0 6px var(--ujs-green);
}
.ujs-btn-error {
  box-shadow: 0 0 6px var(--ujs-red);
}

.ujs-downloaded .ujs-btn-background {
  background: var(--ujs-green);
}

.ujs-error .ujs-btn-background {
  background: var(--ujs-error);
}

.ujs-btn-error-text {
  display: flex;
  align-items: center;
  justify-content: center;
  color: black;
  font-size: 100%;
}
.ujs-modal-settings fieldset {
    border: 1px solid grey;
    margin: 1px;
    padding: 4px;
    border-radius: 2px;
}
.ujs-modal-settings fieldset input {
    margin: 4px;
}
.ujs-modal-settings hr {
    margin: 4px;
    color: grey;
}
.ujs-modal-settings button {
    border: 1px solid grey;
    border-radius: 2px;
}
.ujs-modal-settings button {
    background-color: #FFF;
}
.ujs-modal-settings button:hover {
    background-color: #EEE;
}
.ujs-modal-settings button:active {
    background-color: #DDD;
}


.ujs-btn-download[data-is-multi-media] .ujs-dot {
    position: absolute;
    width: 6px;
    height: 6px;
    background: rgba(255, 255, 255, 0.5) linear-gradient(to right, white var(--media-progress), transparent 0%);
    border-radius: 25%;

    bottom: 3px;
    right: 3px;
}
.ujs-btn-download[data-is-multi-media] .ujs-dot.ujs-back {
    bottom: 4px;
    right: 1px;

    background: transparent;
    border-top:   1px solid rgba(255, 255, 255, 0.5);
    border-right: 1px solid rgba(255, 255, 255, 0.5);
}

.ujs-btn-download[data-is-multi-media] .ujs-dot[style="--media-progress: 100%;"] + .ujs-back {
    border-top:   1px solid white;
    border-right: 1px solid white;
}

.ujs-btn-download {
  --xsave-video-edge: ${runtimePreferences.addBorder ? "rgba(226,232,240,.65)" : "rgba(148,163,184,.28)"};
  --xsave-video-ink: #a5f3fc;
  --xsave-video-symbol: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20%3E%20%3Cpath%20d%3D%22M4%2017v2a2%202%200%200%200%202%202h12a2%202%200%200%200%202%20-2v-2%22%20%2F%3E%20%3Cpath%20d%3D%22M7%2011l5%205l5%20-5%22%20%2F%3E%20%3Cpath%20d%3D%22M12%204l0%2012%22%20%2F%3E%20%3C%2Fsvg%3E");
  width: 46px;
  height: 46px;
  border-radius: 50%;
}
.ujs-btn-download > .ujs-btn-common {
  box-sizing: border-box;
  width: 46px;
  height: 46px;
  border: 0;
  border-radius: 50%;
}
.ujs-btn-download > .ujs-btn-background {
  border: 1px solid var(--xsave-video-edge);
  background: #111c2b;
  box-shadow: 0 4px 14px #0005, inset 0 1px 0 #ffffff12;
  transition: background-color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
}
.ujs-btn-download > .ujs-btn-background::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 22px;
  height: 22px;
  transform: translate(-50%, -50%);
  background: var(--xsave-video-ink);
  -webkit-mask: var(--xsave-video-symbol) center / contain no-repeat;
  mask: var(--xsave-video-symbol) center / contain no-repeat;
}
.ujs-btn-download:hover > .ujs-btn-background {
  background: #1b3045;
  border-color: #67e8f9;
  box-shadow: 0 5px 18px #0006, 0 0 0 3px #67e8f91c;
}
.ujs-btn-download:active > .ujs-btn-background {
  transform: scale(.94);
}
.ujs-btn-download > .ujs-hover,
.ujs-btn-download > .ujs-shadow {
  background: none;
  pointer-events: none;
}
.ujs-btn-download > .ujs-progress {
  background: conic-gradient(#67e8f9 var(--progress, 0%), transparent 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
  pointer-events: none;
}
.ujs-btn-download.ujs-downloading > .ujs-btn-background::after {
  opacity: 0;
}
.ujs-btn-download.ujs-downloading > .ujs-shadow::after {
  content: "";
  position: absolute;
  inset: 13px;
  border: 2px solid #67e8f933;
  border-top-color: #a5f3fc;
  border-radius: 50%;
  animation: xsave-video-pending 850ms linear infinite;
}
.ujs-btn-download.ujs-downloaded,
.ujs-btn-download.ujs-already-downloaded {
  --xsave-video-ink: #5eead4;
  --xsave-video-symbol: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20%3E%20%3Cpath%20d%3D%22M5%2012l5%205l10%20-10%22%20%2F%3E%20%3C%2Fsvg%3E");
}
.ujs-btn-download.ujs-downloaded > .ujs-btn-background,
.ujs-btn-download.ujs-already-downloaded > .ujs-btn-background {
  background: #102f31;
  border-color: #5eead480;
}
.ujs-btn-download.ujs-error {
  --xsave-video-ink: #fda4af;
  --xsave-video-symbol: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20%3E%20%3Cpath%20d%3D%22M18%206l-12%2012%22%20%2F%3E%20%3Cpath%20d%3D%22M6%206l12%2012%22%20%2F%3E%20%3C%2Fsvg%3E");
}
.ujs-btn-download.ujs-error > .ujs-btn-background {
  background: #351d2b;
  border-color: #fda4af99;
}
.ujs-btn-download > .ujs-btn-error-text {
  background-image: none !important;
  pointer-events: none;
}
.ujs-btn-download[title^="[warning]"] > .ujs-btn-background {
  background: #362719;
  border-color: #fcd34d99;
}
.ujs-btn-download[title^="[warning]"] > .ujs-btn-background::after {
  content: "!";
  display: grid;
  place-items: center;
  background: transparent;
  color: #fcd34d;
  font: 700 22px/1 system-ui, sans-serif;
  -webkit-mask: none;
  mask: none;
}
.ujs-btn-download.ujs-video > .ujs-video-links-toggle {
  top: 7px;
  left: 53px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border-color: #94a3b84d;
  background: #111c2b;
  color: #cbd5e1;
}
.ujs-btn-download.ujs-video > .ujs-video-links-toggle:hover,
.ujs-btn-download.ujs-video > .ujs-video-links-toggle[aria-expanded="true"] {
  background: #1b3045;
  border-color: #67e8f9;
  color: #a5f3fc;
}
.ujs-btn-download[data-is-multi-media] .ujs-dot {
  bottom: 3px;
  right: 4px;
  border-radius: 50%;
}
.ujs-btn-download[data-is-multi-media] .ujs-dot.ujs-back {
  bottom: 4px;
  right: 2px;
}
@keyframes xsave-video-pending {
  to { transform: rotate(1turn); }
}
@media (prefers-reduced-motion: reduce) {
  .ujs-btn-download > .ujs-btn-background {
    transition: none;
  }
  .ujs-btn-download.ujs-downloading > .ujs-shadow::after {
    animation: none;
  }
}

`;
  return pageStylesheetText.trimStart();
}
function readLocalizedLabels() {
  const fallbackQuoteMarks = [`"`, `"`];
  const SUPPORTED_LOCALE_CODES = ["en", "ru", "es", "zh", "ja"];
  const REVEAL_BUTTON_LABELS = ["View", "Посмотреть", "Ver", "查看", "表示"];
  const PROFILE_REVEAL_LABELS = ["Yes, view profile", "Да, посмотреть профиль", "Sí, ver perfil", "是，查看个人资料", "プロフィールを表示する"];
  const SENSITIVE_CONTENT_REVEAL_LABELS = ["Show", "Показать", "Mostrar", "显示", "表示"];
  const IMAGE_ACCESSIBILITY_LABELS = ["Image", "Изображение", "Imagen", "图像", "画像"];
  const REGISTRATION_LABELS = ["Sign up", "Зарегистрироваться", "Regístrate", "注册", "アカウント作成"];
  const TREND_PANEL_LABELS = ["Timeline: Trending now", "Лента: Актуальные темы", "Cronología: Tendencias del momento", "时间线：当前趋势", "タイムライン: トレンド"];
  const FOOTER_LABELS = ["Footer", "Нижний колонтитул", "Pie de página", "页脚", "フッター"];
  const TITLE_QUOTE_MARKS = [fallbackQuoteMarks, [`«`, `»`], fallbackQuoteMarks, fallbackQuoteMarks, [`「`, `」`]];
  const PLATFORM_TITLE_PREFIXES = [" on X:", " в X:", " en X:", " 在 X:", "さんはXを使っています"];
  const PLATFORM_BRAND_LABELS = ["X", "X", "X", "X", "X"];
  const pageLanguageCode = document.querySelector("html").getAttribute("lang");
  const languageTablePosition = SUPPORTED_LOCALE_CODES.indexOf(pageLanguageCode);
  return {
    SUPPORTED_LANGUAGES: SUPPORTED_LOCALE_CODES,
    VIEW: REVEAL_BUTTON_LABELS[languageTablePosition],
    YES_VIEW_PROFILE: PROFILE_REVEAL_LABELS[languageTablePosition],
    SHOW_NUDITY: SENSITIVE_CONTENT_REVEAL_LABELS[languageTablePosition],
    IMAGE: IMAGE_ACCESSIBILITY_LABELS[languageTablePosition],
    SIGNUP: REGISTRATION_LABELS[languageTablePosition],
    TRENDS: TREND_PANEL_LABELS[languageTablePosition],
    FOOTER: FOOTER_LABELS[languageTablePosition],
    QUOTES: TITLE_QUOTE_MARKS[languageTablePosition],
    ON_TWITTER: PLATFORM_TITLE_PREFIXES[languageTablePosition],
    TWITTER: PLATFORM_BRAND_LABELS[languageTablePosition]
  };
}
function definePostContext() {
  class PostContext {
    constructor({
      elem: contentElement,
      url: resourceAddress
    }) {
      if (resourceAddress) {
        this.elem = null;
        this.url = resourceAddress;
      } else {
        this.elem = contentElement;
        this.url = PostContext.locatePostAddress(contentElement);
      }
    }
    static fromDescendant(descendantElement) {
      const resourceAddress = descendantElement.closest(`a[href^="/"]`)?.href;
      if (resourceAddress && resourceAddress.includes("/status/")) {
        return new PostContext({
          url: resourceAddress
        });
      }
      const contentElement = descendantElement.closest(`[data-testid="tweet"]`);
      if (!contentElement) {
        traceEnabled && console.log("[ujs][Tweet.of]", "No-tweet elem");
      }
      return new PostContext({
        elem: contentElement
      });
    }
    static locatePostAddress(contentElement) {
      if (!contentElement) {
        traceEnabled && console.log("[ujs][Tweet.getUrl]", "Opened full screen image");
        return location.href;
      }
      const postTimestampAnchor = [...contentElement.querySelectorAll("a")].find(candidateEntry => {
        return candidateEntry.childNodes[0]?.nodeName === "TIME";
      });
      if (postTimestampAnchor) {
        traceEnabled && console.log("[ujs][Tweet.getUrl]", "Quoted/Re Tweet");
        return postTimestampAnchor.href;
      }
      traceEnabled && console.log("[ujs][Tweet.getUrl]", "Unreachable");
      return location.href;
    }
    get author() {
      return this.url.match(/(?<=(twitter|x)\.com\/).+?(?=\/)/)?.[0];
    }
    get id() {
      return this.url.match(/(?<=\/status\/)\d+/)?.[0];
    }
  }
  return PostContext;
}
function definePostService() {
  class PostService {
    static anonymousSessionToken = readCookieValue("gt");
    static requestForgeryToken = readCookieValue("ct0");
    static anonymousAuthorizationHeader = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
    static async extractClientAuthorization() {
      const clientBundleAddress = [...document.querySelectorAll("script")].find(candidateEntry => candidateEntry.src.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main[\w.]*\.js/)).src;
      let displayText;
      try {
        displayText = await (await performPageRequest(clientBundleAddress)).text();
      } catch (caughtFailure) {
        console.error("[ujs][_requestBearerToken][scriptSrc]", clientBundleAddress);
        console.error("[ujs][_requestBearerToken]", caughtFailure);
        throw caughtFailure;
      }
      const authorizationTokenValue = displayText.match(/(?<=")AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D.+?(?=")/)[0];
      const authorizationHeaderValue = `Bearer ${authorizationTokenValue}`;
      return authorizationHeaderValue;
    }
    static async resolveAuthorizationHeader() {
      if (!PostService.authorization) {
        PostService.authorization = await PostService.extractClientAuthorization();
      }
      return PostService.authorization;
    }
    static cachedServiceDocuments = new Map();
    static evictOldestServiceDocument() {
      if (PostService.cachedServiceDocuments.size > 16) {
        PostService.cachedServiceDocuments.delete(PostService.cachedServiceDocuments.keys().next().value);
      }
    }
    static async requestServiceDocument(resourceAddress, downloadTaskKey) {
      const normalizedResourceLocation = resourceAddress.toString();
      traceEnabled && console.log("[ujs][apiRequest]", normalizedResourceLocation);
      if (PostService.cachedServiceDocuments.has(normalizedResourceLocation)) {
        if (downloadTaskKey) downloadDiagnostics.info(downloadTaskKey, "使用缓存的推文接口响应");
        traceEnabled && console.log("[ujs][apiRequest] Use cached API request", normalizedResourceLocation);
        return PostService.cachedServiceDocuments.get(normalizedResourceLocation);
      }
      const authorizationHeaderValue = PostService.anonymousAuthorizationHeader;
      traceEnabled && sessionStorage.setItem("guestAuthorization", PostService.anonymousAuthorizationHeader);
      traceEnabled && sessionStorage.setItem("authorization", PostService.authorization);
      traceEnabled && sessionStorage.setItem("x-csrf-token", PostService.requestForgeryToken);
      traceEnabled && sessionStorage.setItem("x-guest-token", PostService.anonymousSessionToken);
      const requestHeaderBag = new Headers({
        authorization: authorizationHeaderValue,
        "x-csrf-token": PostService.requestForgeryToken,
        "x-twitter-client-language": "en",
        "x-twitter-active-user": "yes",
        "content-type": "application/json"
      });
      if (PostService.anonymousSessionToken) {
        requestHeaderBag.append("x-guest-token", PostService.anonymousSessionToken);
      } else {
        requestHeaderBag.append("x-twitter-auth-type", "OAuth2Session");
      }
      let serviceDocument;
      if (downloadTaskKey) downloadDiagnostics.info(downloadTaskKey, "发送推文接口请求", {
        endpoint: downloadDiagnostics.url(normalizedResourceLocation)
      });
      const stopWaitHeartbeat = downloadDiagnostics.wait(downloadTaskKey, "推文接口请求或响应解析");
      try {
        const receivedResponse = await performPageRequest(normalizedResourceLocation, {
          headers: requestHeaderBag
        });
        if (downloadTaskKey) downloadDiagnostics.info(downloadTaskKey, "推文接口返回响应", {
          status: receivedResponse.status,
          ok: receivedResponse.ok
        });
        serviceDocument = await receivedResponse.json();
        if (!receivedResponse.ok) {
          const serviceFailureSummary = serviceDocument?.errors?.map(failureCause => failureCause.message).filter(Boolean).join("; ");
          throw new Error(`Twitter API HTTP ${receivedResponse.status}${serviceFailureSummary ? ": " + serviceFailureSummary : ""}`);
        }
        if (receivedResponse.ok) {
          traceEnabled && console.log("[ujs][apiRequest]", "Cache API request", normalizedResourceLocation);
          PostService.evictOldestServiceDocument();
          PostService.cachedServiceDocuments.set(normalizedResourceLocation, serviceDocument);
        }
      } catch (caughtFailure) {
        console.error("[ujs][apiRequest]", normalizedResourceLocation);
        console.error("[ujs][apiRequest]", caughtFailure);
        throw caughtFailure;
      } finally {
        stopWaitHeartbeat();
      }
      traceEnabled && console.log("[ujs][apiRequest][json]", JSON.stringify(serviceDocument, null, " "));
      return serviceDocument;
    }
    static decodeTimelinePost(serviceDocument, referencedPostKey) {
      const timelineInsertionInstruction = serviceDocument.data.threaded_conversation_with_injections_v2.instructions.find(timelineInstructionEntry => timelineInstructionEntry.type === "TimelineAddEntries");
      const timelinePostEntry = timelineInsertionInstruction.entries.find(timelineInstructionEntry => timelineInstructionEntry.entryId === "tweet-" + referencedPostKey);
      let postResultDocument = timelinePostEntry.content.itemContent.tweet_results.result;
      if ("tweet" in postResultDocument) {
        postResultDocument = postResultDocument.tweet;
      }
      traceEnabled && console.log("[ujs][parseTweetJsonFrom_TweetDetail] tweetResult", postResultDocument, JSON.stringify(postResultDocument));
      const postCreatorDocument = postResultDocument.core.user_results.result;
      const legacyPostFields = postResultDocument.legacy;
      traceEnabled && console.log("[ujs][parseTweetJsonFrom_TweetDetail] tweetLegacy", legacyPostFields, JSON.stringify(legacyPostFields));
      traceEnabled && console.log("[ujs][parseTweetJsonFrom_TweetDetail] tweetUser", postCreatorDocument, JSON.stringify(postCreatorDocument));
      return {
        tweetResult: postResultDocument,
        tweetLegacy: legacyPostFields,
        tweetUser: postCreatorDocument
      };
    }
    static decodeSinglePost(serviceDocument, referencedPostKey) {
      let postResultDocument = serviceDocument?.data?.tweetResult?.result;
      if (postResultDocument?.tweet) {
        postResultDocument = postResultDocument.tweet;
      }
      if (!postResultDocument?.legacy || !postResultDocument.core?.user_results?.result) {
        const serviceFailureSummary = serviceDocument?.errors?.map(failureCause => failureCause.message).filter(Boolean).join("; ");
        throw new Error(`No accessible tweet data for ${referencedPostKey}. ${serviceFailureSummary || "Check login and tweet visibility."}`);
      }
      const postCreatorDocument = postResultDocument.core.user_results.result;
      const legacyPostFields = postResultDocument.legacy;
      return {
        tweetResult: postResultDocument,
        tweetLegacy: legacyPostFields,
        tweetUser: postCreatorDocument
      };
    }
    static decodeMediaDescriptors(postResultDocument, legacyPostFields, postCreatorDocument) {
      let rawMediaDescriptors = [];
      if (legacyPostFields.extended_entities && legacyPostFields.extended_entities.media) {
        rawMediaDescriptors = legacyPostFields.extended_entities.media;
      } else if ("card" in postResultDocument) {
        try {
          const unifiedCardBinding = postResultDocument.card.legacy.binding_values.find(cardBindingEntry => cardBindingEntry.key === "unified_card");
          traceEnabled && console.log("[ujs][getTweetMedias] unified_card", unifiedCardBinding, unifiedCardBinding.value.string_value);
          const entryContent = JSON.parse(unifiedCardBinding.value.string_value);
          traceEnabled && console.log("[ujs][getTweetMedias] unified_card value", entryContent);
          rawMediaDescriptors = Object.values(entryContent.media_entities);
        } catch (cardParsingFailure) {
          traceEnabled && console.log("[ujs][getTweetMedias] failed to parse unified_card", cardParsingFailure);
          return [];
        }
      } else {
        return [];
      }
      const mediaDescriptors = [];
      const mediaCategoryCounters = {};
      let entryPosition = -1;
      for (const mediaDescriptor of rawMediaDescriptors) {
        entryPosition++;
        let mediaCategory = mediaDescriptor.type;
        const originalMediaCategory = mediaDescriptor.type;
        mediaCategoryCounters[mediaCategory] = (mediaCategoryCounters[mediaCategory] === undefined ? -1 : mediaCategoryCounters[mediaCategory]) + 1;
        if (mediaCategory === "animated_gif") {
          mediaCategory = "video";
          mediaCategoryCounters[mediaCategory] = (mediaCategoryCounters[mediaCategory] === undefined ? -1 : mediaCategoryCounters[mediaCategory]) + 1;
        }
        let preferredMediaAddress;
        let progressiveMediaAddresses;
        let streamingSourceAddresses;
        let videoVariantMetadata;
        if (mediaCategory === "video") {
          const availableVideoVariants = Array.isArray(mediaDescriptor.video_info?.variants) ? mediaDescriptor.video_info.variants : [];
          const usableVideoVariants = availableVideoVariants.filter(videoVariant => videoVariant && typeof videoVariant.url === "string" && /^https?:\/\//i.test(videoVariant.url));
          const readVariantMimeType = videoVariant => (videoVariant.content_type || "").split(";")[0].trim().toLowerCase();
          const isStreamingVariant = videoVariant => /mpegurl/.test(readVariantMimeType(videoVariant)) || /\.m3u8(?:[?#]|$)/i.test(videoVariant.url);
          const readVariantBitrate = videoVariant => Number.isFinite(Number(videoVariant.bitrate)) ? Number(videoVariant.bitrate) : 0;
          progressiveMediaAddresses = [...new Set(usableVideoVariants.filter(videoVariant => !isStreamingVariant(videoVariant) && (readVariantMimeType(videoVariant) === "video/mp4" || /\.mp4(?:[?#]|$)/i.test(videoVariant.url))).sort((firstCandidate, secondCandidate) => readVariantBitrate(secondCandidate) - readVariantBitrate(firstCandidate)).map(videoVariant => videoVariant.url))];
          streamingSourceAddresses = [...new Set(usableVideoVariants.filter(isStreamingVariant).map(videoVariant => videoVariant.url))];
          videoVariantMetadata = usableVideoVariants.map(videoVariant => ({
            url: videoVariant.url,
            content_type: readVariantMimeType(videoVariant),
            bitrate: readVariantBitrate(videoVariant)
          }));
          preferredMediaAddress = progressiveMediaAddresses[0];
        } else {
          if (mediaDescriptor.media_url_https.includes("?format=")) {
            preferredMediaAddress = mediaDescriptor.media_url_https;
          } else {
            const addressSegments = mediaDescriptor.media_url_https.split(".");
            const sourceFileSuffix = addressSegments[addressSegments.length - 1];
            const mediaAddressStem = addressSegments.slice(0, -1).join(".");
            preferredMediaAddress = `${mediaAddressStem}?format=${sourceFileSuffix}&name=orig`;
          }
        }
        const sourceCreatorHandle = postCreatorDocument.legacy.screen_name;
        const sourcePostIdentifier = postResultDocument.rest_id || legacyPostFields.id_str;
        const normalizedMediaPosition = mediaCategoryCounters[mediaCategory];
        const originalMediaPosition = mediaCategoryCounters[originalMediaCategory];
        const previewImageAddress = mediaDescriptor.media_url_https;
        const mediaIdentifier = mediaDescriptor.id_str;
        const mediaLookupKey = mediaDescriptor.media_key;
        const expandedPostAddress = mediaDescriptor.expanded_url;
        const displayPostAddress = mediaDescriptor.display_url;
        const redirectedPostAddress = mediaDescriptor.url;
        const sourcePostText = legacyPostFields.full_text.replace(` ${mediaDescriptor.url}`, "");
        const selectedMediaDescriptor = {
          screen_name: sourceCreatorHandle,
          tweet_id: sourcePostIdentifier,
          download_url: preferredMediaAddress,
          download_urls: progressiveMediaAddresses,
          hls_urls: streamingSourceAddresses,
          video_variants: videoVariantMetadata,
          type: mediaCategory,
          type_original: originalMediaCategory,
          index: entryPosition,
          type_index: normalizedMediaPosition,
          type_index_original: originalMediaPosition,
          preview_url: previewImageAddress,
          media_id: mediaIdentifier,
          media_key: mediaLookupKey,
          expanded_url: expandedPostAddress,
          short_expanded_url: displayPostAddress,
          short_tweet_url: redirectedPostAddress,
          tweet_text: sourcePostText
        };
        mediaDescriptors.push(selectedMediaDescriptor);
      }
      traceEnabled && console.log("[ujs][parseTweetLegacyMedias] medias", mediaDescriptors);
      return mediaDescriptors;
    }
    static async readPostMediaDescriptors(referencedPostKey, downloadTaskKey) {
      const resourceAddress = PostService.buildSinglePostRequest(referencedPostKey);
      if (downloadTaskKey) downloadDiagnostics.info(downloadTaskKey, "开始获取视频信息", {
        tweetId: referencedPostKey
      });
      const serviceDocument = await PostService.requestServiceDocument(resourceAddress, downloadTaskKey);
      traceEnabled && console.log("[ujs][getTweetMedias]", serviceDocument, JSON.stringify(serviceDocument));
      const {
        tweetResult: postResultDocument,
        tweetLegacy: legacyPostFields,
        tweetUser: postCreatorDocument
      } = PostService.decodeSinglePost(serviceDocument, referencedPostKey);
      let resolvedResult = PostService.decodeMediaDescriptors(postResultDocument, legacyPostFields, postCreatorDocument);
      if (postResultDocument.quoted_status_result && postResultDocument.quoted_status_result.result) {
        let quotedPostResult = postResultDocument.quoted_status_result.result;
        if ("tweet" in quotedPostResult) {
          quotedPostResult = quotedPostResult.tweet;
        }
        const quotedLegacyPostFields = quotedPostResult.legacy;
        const quotedPostCreator = quotedPostResult.core.user_results.result;
        resolvedResult = [...resolvedResult, ...PostService.decodeMediaDescriptors(quotedPostResult, quotedLegacyPostFields, quotedPostCreator)];
      }
      if (downloadTaskKey) downloadDiagnostics.info(downloadTaskKey, "推文媒体解析完成", {
        mediaCount: resolvedResult.length,
        videos: resolvedResult.filter(mediaDescriptor => mediaDescriptor.type === "video").map(mediaDescriptor => ({
          mediaId: mediaDescriptor.media_id,
          tweetId: mediaDescriptor.tweet_id,
          mp4Count: mediaDescriptor.download_urls?.length || 0,
          hlsCount: mediaDescriptor.hls_urls?.length || 0
        }))
      });
      return resolvedResult;
    }
    static timelineQueryIdentifier = "_8aYOgEDz35BrBcBal1-_w";
    static profileQueryIdentifier = "1VOOyvKkiI3FMmkeDNxM9A";
    static singlePostQueryIdentifier = "zAz9764BcLZOJ0JU2wrd1A";
    static buildSinglePostRequest(referencedPostKey) {
      const serviceQueryVariables = {
        "tweetId": referencedPostKey,
        "withCommunity": false,
        "includePromotedContent": false,
        "withVoice": false
      };
      const serviceFeatureFlags = {
        "creator_subscriptions_tweet_preview_api_enabled": true,
        "premium_content_api_read_enabled": false,
        "communities_web_enable_tweet_community_results_fetch": true,
        "c9s_tweet_anatomy_moderator_badge_enabled": true,
        "responsive_web_grok_analyze_button_fetch_trends_enabled": false,
        "responsive_web_grok_analyze_post_followups_enabled": false,
        "responsive_web_jetfuel_frame": false,
        "responsive_web_grok_share_attachment_enabled": true,
        "articles_preview_enabled": true,
        "responsive_web_edit_tweet_api_enabled": true,
        "graphql_is_translatable_rweb_tweet_is_translatable_enabled": true,
        "view_counts_everywhere_api_enabled": true,
        "longform_notetweets_consumption_enabled": true,
        "responsive_web_twitter_article_tweet_consumption_enabled": true,
        "tweet_awards_web_tipping_enabled": false,
        "responsive_web_grok_show_grok_translated_post": false,
        "responsive_web_grok_analysis_button_from_backend": false,
        "creator_subscriptions_quote_tweet_preview_enabled": false,
        "freedom_of_speech_not_reach_fetch_enabled": true,
        "standardized_nudges_misinfo": true,
        "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": true,
        "longform_notetweets_rich_text_read_enabled": true,
        "longform_notetweets_inline_media_enabled": true,
        "profile_label_improvements_pcf_label_in_post_enabled": true,
        "rweb_tipjar_consumption_enabled": true,
        "verified_phone_label_enabled": false,
        "responsive_web_grok_image_annotation_enabled": true,
        "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
        "responsive_web_graphql_timeline_navigation_enabled": true,
        "responsive_web_enhance_cards_enabled": false
      };
      const serviceFieldOptions = {
        "withArticleRichContentState": true,
        "withArticlePlainText": false,
        "withGrokAnalyze": false,
        "withDisallowedReplyControls": false
      };
      const serviceEndpointBase = `https://${platformHostLabel}.com/i/api/graphql/${PostService.singlePostQueryIdentifier}/TweetResultByRestId`;
      const parsedResourceAddress = new URL(serviceEndpointBase);
      parsedResourceAddress.searchParams.set("variables", JSON.stringify(serviceQueryVariables));
      parsedResourceAddress.searchParams.set("features", JSON.stringify(serviceFeatureFlags));
      parsedResourceAddress.searchParams.set("fieldToggles", JSON.stringify(serviceFieldOptions));
      const resourceAddress = parsedResourceAddress.toString();
      return resourceAddress;
    }
    static buildTimelineRequest(referencedPostKey) {
      const serviceQueryVariables = {
        "focalTweetId": referencedPostKey,
        "rankingMode": "Relevance",
        "includePromotedContent": true,
        "withCommunity": true,
        "withQuickPromoteEligibilityTweetFields": true,
        "withBirdwatchNotes": true,
        "withVoice": true
      };
      const serviceFeatureFlags = {
        "rweb_video_screen_enabled": false,
        "profile_label_improvements_pcf_label_in_post_enabled": true,
        "rweb_tipjar_consumption_enabled": true,
        "verified_phone_label_enabled": false,
        "creator_subscriptions_tweet_preview_api_enabled": true,
        "responsive_web_graphql_timeline_navigation_enabled": true,
        "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
        "premium_content_api_read_enabled": false,
        "communities_web_enable_tweet_community_results_fetch": true,
        "c9s_tweet_anatomy_moderator_badge_enabled": true,
        "responsive_web_grok_analyze_button_fetch_trends_enabled": false,
        "responsive_web_grok_analyze_post_followups_enabled": true,
        "responsive_web_jetfuel_frame": false,
        "responsive_web_grok_share_attachment_enabled": true,
        "articles_preview_enabled": true,
        "responsive_web_edit_tweet_api_enabled": true,
        "graphql_is_translatable_rweb_tweet_is_translatable_enabled": true,
        "view_counts_everywhere_api_enabled": true,
        "longform_notetweets_consumption_enabled": true,
        "responsive_web_twitter_article_tweet_consumption_enabled": true,
        "tweet_awards_web_tipping_enabled": false,
        "responsive_web_grok_show_grok_translated_post": false,
        "responsive_web_grok_analysis_button_from_backend": true,
        "creator_subscriptions_quote_tweet_preview_enabled": false,
        "freedom_of_speech_not_reach_fetch_enabled": true,
        "standardized_nudges_misinfo": true,
        "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": true,
        "longform_notetweets_rich_text_read_enabled": true,
        "longform_notetweets_inline_media_enabled": true,
        "responsive_web_grok_image_annotation_enabled": true,
        "responsive_web_enhance_cards_enabled": false
      };
      const serviceFieldOptions = {
        "withArticleRichContentState": true,
        "withArticlePlainText": false,
        "withGrokAnalyze": false,
        "withDisallowedReplyControls": false
      };
      const serviceEndpointBase = `https://${platformHostLabel}.com/i/api/graphql/${PostService.timelineQueryIdentifier}/TweetDetail`;
      const parsedResourceAddress = new URL(serviceEndpointBase);
      parsedResourceAddress.searchParams.set("variables", JSON.stringify(serviceQueryVariables));
      parsedResourceAddress.searchParams.set("features", JSON.stringify(serviceFeatureFlags));
      parsedResourceAddress.searchParams.set("fieldToggles", JSON.stringify(serviceFieldOptions));
      const resourceAddress = parsedResourceAddress.toString();
      return resourceAddress;
    }
    static async readProfileDestination(profileHandle) {
      const serviceQueryVariables = {
        "screen_name": profileHandle
      };
      const serviceFeatureFlags = {
        "hidden_profile_subscriptions_enabled": true,
        "profile_label_improvements_pcf_label_in_post_enabled": true,
        "rweb_tipjar_consumption_enabled": true,
        "verified_phone_label_enabled": false,
        "subscriptions_verification_info_is_identity_verified_enabled": true,
        "subscriptions_verification_info_verified_since_enabled": true,
        "highlights_tweets_tab_ui_enabled": true,
        "responsive_web_twitter_article_notes_tab_enabled": true,
        "subscriptions_feature_can_gift_premium": true,
        "creator_subscriptions_tweet_preview_api_enabled": true,
        "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
        "responsive_web_graphql_timeline_navigation_enabled": true
      };
      const serviceFieldOptions = {
        "withAuxiliaryUserLabels": true
      };
      const serviceEndpointBase = `https://${platformHostLabel}.com/i/api/graphql/${PostService.profileQueryIdentifier}/UserByScreenName?`;
      const parsedResourceAddress = new URL(serviceEndpointBase);
      parsedResourceAddress.searchParams.set("variables", JSON.stringify(serviceQueryVariables));
      parsedResourceAddress.searchParams.set("features", JSON.stringify(serviceFeatureFlags));
      parsedResourceAddress.searchParams.set("fieldToggles", JSON.stringify(serviceFieldOptions));
      const resourceAddress = parsedResourceAddress.toString();
      const serviceDocument = await PostService.requestServiceDocument(resourceAddress);
      traceEnabled && console.log("[ujs][getUserInfo][json]", serviceDocument);
      return serviceDocument.data.user.result.legacy.entities.url?.urls[0].expanded_url;
    }
  }
  return PostService;
}
function createHistoryOperations() {
  function migrateLegacyStorage() {
    const storageMigrationPairs = [[storageKeys.settings, legacyStorageKeys.settings], [storageKeys.settingsImageHistoryBy, legacyStorageKeys.settingsImageHistoryBy], [storageKeys.downloadedImageNames, legacyStorageKeys.downloadedImageNames], [storageKeys.downloadedImageTweetIds, legacyStorageKeys.downloadedImageTweetIds], [storageKeys.downloadedVideoTweetIds, legacyStorageKeys.downloadedVideoTweetIds]];
    function replaceLegacyStorageEntry(currentStorageKey, legacyStorageKey, entryContent) {
      try {
        localStorage.setItem(currentStorageKey, entryContent);
      } catch (caughtFailure) {
        localStorage.removeItem(legacyStorageKey);
        localStorage.setItem(currentStorageKey, entryContent);
      }
      localStorage.removeItem(legacyStorageKey);
    }
    function mergeLegacyStorageEntry({
      newName: currentStorageKey,
      oldName: legacyStorageKey
    }) {
      const legacyStoredText = localStorage.getItem(legacyStorageKey);
      if (legacyStoredText === null) {
        return;
      }
      const currentStoredText = localStorage.getItem(currentStorageKey);
      if (currentStoredText === null) {
        replaceLegacyStorageEntry(currentStorageKey, legacyStorageKey, legacyStoredText);
        return;
      }
      try {
        const legacyStoredEntries = JSON.parse(legacyStoredText);
        const currentStoredEntries = JSON.parse(currentStoredText);
        if (Array.isArray(legacyStoredEntries) && Array.isArray(currentStoredEntries)) {
          const mergedHistoryEntries = [...new Set([...currentStoredEntries, ...legacyStoredEntries])];
          const mergedHistoryText = JSON.stringify(mergedHistoryEntries);
          replaceLegacyStorageEntry(currentStorageKey, legacyStorageKey, mergedHistoryText);
        }
      } catch (caughtFailure) {}
    }
    for (const [currentStorageKey, legacyStorageKey] of storageMigrationPairs) {
      mergeLegacyStorageEntry({
        newName: currentStorageKey,
        oldName: legacyStorageKey
      });
    }
  }
  function exportSavedRecords(handleOperationSuccess) {
    const historyExportDocument = [storageKeys.settings, storageKeys.settingsImageHistoryBy, storageKeys.downloadedImageNames, storageKeys.downloadedImageTweetIds, storageKeys.downloadedVideoTweetIds].reduce((collectedEntries, entryName) => {
      const serializedStorageEntry = localStorage.getItem(entryName);
      if (serializedStorageEntry === null) {
        return collectedEntries;
      }
      let entryContent = JSON.parse(serializedStorageEntry);
      if (Array.isArray(entryContent)) {
        entryContent = [...new Set(entryContent)];
      }
      collectedEntries[entryName] = entryContent;
      return collectedEntries;
    }, {});
    const detectedBrowserLabel = localStorage.getItem(storageKeys.browserName) || detectBrowserFamily();
    const browserFilenameSuffix = detectedBrowserLabel ? "-" + detectedBrowserLabel : "";
    savePayloadToDevice(new Blob([serializeHistoryDocument(historyExportDocument, true)]), `ujs-twitter-click-n-save-export-${formatCalendarDate(new Date(), calendarOutputPattern)}${browserFilenameSuffix}.json`);
    handleOperationSuccess();
  }
  function validateHistoryImport(importDocument) {
    if (Array.isArray(importDocument)) {
      throw new Error("Wrong object! JSON contains an array.");
    }
    if (Object.keys(importDocument).some(propertyName => !propertyName.startsWith("ujs-twitter-click-n-save"))) {
      throw new Error("Wrong object! The keys should start with 'ujs-twitter-click-n-save'.");
    }
  }
  function importSavedRecords(handleOperationSuccess, handleOperationFailure) {
    const historyImportInput = document.createElement("input");
    historyImportInput.type = "file";
    historyImportInput.accept = "application/json";
    historyImportInput.style.display = "none";
    document.body.prepend(historyImportInput);
    historyImportInput.addEventListener("change", async unusedDomEvent => {
      let serviceDocument;
      try {
        serviceDocument = JSON.parse(await historyImportInput.files[0].text());
        validateHistoryImport(serviceDocument);
        Object.entries(serviceDocument).forEach(([propertyName, entryContent]) => {
          if (Array.isArray(entryContent)) {
            entryContent = [...new Set(entryContent)];
          }
          localStorage.setItem(propertyName, JSON.stringify(entryContent));
        });
        handleOperationSuccess();
      } catch (caughtFailure) {
        handleOperationFailure(caughtFailure);
      } finally {
        await waitForMilliseconds(1000);
        historyImportInput.remove();
      }
    });
    historyImportInput.click();
  }
  function mergeSavedRecords(handleOperationSuccess, handleOperationFailure) {
    const historyMergeInput = document.createElement("input");
    historyMergeInput.type = "file";
    historyMergeInput.accept = "application/json";
    historyMergeInput.style.display = "none";
    document.body.prepend(historyMergeInput);
    historyMergeInput.addEventListener("change", async unusedDomEvent => {
      let serviceDocument;
      try {
        serviceDocument = JSON.parse(await historyMergeInput.files[0].text());
        validateHistoryImport(serviceDocument);
        Object.entries(serviceDocument).forEach(([propertyName, entryContent]) => {
          if (!Array.isArray(entryContent)) {
            return;
          }
          const previousStoredText = JSON.parse(localStorage.getItem(propertyName));
          if (Array.isArray(previousStoredText)) {
            const mergedStoredText = [...new Set([...previousStoredText, ...entryContent])];
            localStorage.setItem(propertyName, JSON.stringify(mergedStoredText));
          } else {
            localStorage.setItem(propertyName, JSON.stringify(entryContent));
          }
        });
        handleOperationSuccess();
      } catch (caughtFailure) {
        handleOperationFailure(caughtFailure);
      } finally {
        await waitForMilliseconds(1000);
        historyMergeInput.remove();
      }
    });
    historyMergeInput.click();
  }
  return {
    exportHistory: exportSavedRecords,
    importHistory: importSavedRecords,
    mergeHistory: mergeSavedRecords,
    migrateLocalStore: migrateLegacyStorage
  };
}
function defineJsonStorage(runtimePreferences = {}) {
  const {
    verbose: traceEnabled
  } = runtimePreferences;
  class JsonStorage {
    constructor(entryName) {
      this.name = entryName;
    }
    getItem(fallbackStoredValue) {
      return JsonStorage.readJsonEntry(this.name, fallbackStoredValue);
    }
    setItem(entryContent) {
      JsonStorage.writeJsonEntry(this.name, entryContent);
    }
    removeItem() {
      JsonStorage.deleteJsonEntry(this.name);
    }
    async pushItem(entryContent) {
      await JsonStorage.appendJsonEntry(this.name, entryContent);
    }
    async popItem(entryContent) {
      await JsonStorage.removeJsonArrayEntry(this.name, entryContent);
    }
    hasItem(entryContent) {
      return JsonStorage.containsJsonArrayEntry(this.name, entryContent);
    }
    static readJsonEntry(entryName, fallbackStoredValue) {
      const entryContent = localStorage.getItem(entryName);
      if (entryContent === undefined) {
        return undefined;
      }
      if (entryContent === null) {
        JsonStorage.writeJsonEntry(entryName, fallbackStoredValue);
        return fallbackStoredValue;
      }
      return JSON.parse(entryContent);
    }
    static writeJsonEntry(entryName, entryContent) {
      localStorage.setItem(entryName, JSON.stringify(entryContent));
    }
    static deleteJsonEntry(entryName) {
      localStorage.removeItem(entryName);
    }
    static async appendJsonEntry(entryName, entryContent) {
      const storedEntries = JsonStorage.readJsonEntry(entryName, []);
      storedEntries.push(entryContent);
      JsonStorage.writeJsonEntry(entryName, storedEntries);
      await waitForMilliseconds(50);
      if (!JsonStorage.containsJsonArrayEntry(entryName, entryContent)) {
        if (traceEnabled) {
          document.title = "🟥" + document.title;
        }
        await JsonStorage.appendJsonEntry(entryName, entryContent);
      }
    }
    static async removeJsonArrayEntry(entryName, entryContent) {
      const storedEntries = JsonStorage.readJsonEntry(entryName, []);
      if (storedEntries.indexOf(entryContent) !== -1) {
        storedEntries.splice(storedEntries.indexOf(entryContent), 1);
        JsonStorage.writeJsonEntry(entryName, storedEntries);
        await waitForMilliseconds(50);
        if (JsonStorage.containsJsonArrayEntry(entryName, entryContent)) {
          if (traceEnabled) {
            document.title = "🟨" + document.title;
          }
          await JsonStorage.removeJsonArrayEntry(entryName, entryContent);
        }
      }
    }
    static containsJsonArrayEntry(entryName, entryContent) {
      const storedEntries = JsonStorage.readJsonEntry(entryName, []);
      return storedEntries.indexOf(entryContent) !== -1;
    }
  }
  return JsonStorage;
}
function createRuntimeUtilities({
  verbose: traceEnabled
}) {
  function waitForMilliseconds(delayMilliseconds) {
    return new Promise(fulfillPendingPromise => setTimeout(fulfillPendingPromise, delayMilliseconds));
  }
  function describeVideoSourceChoices(selectedMediaDescriptor) {
    const progressiveSourceAddresses = selectedMediaDescriptor.download_urls || (selectedMediaDescriptor.download_url ? [selectedMediaDescriptor.download_url] : []);
    const variantMetadataLookup = new Map((selectedMediaDescriptor.video_variants || []).map(videoVariant => [videoVariant.url, videoVariant]));
    const seenSourceAddresses = new Set();
    const sourceChoiceDescriptors = [];
    for (const [containerFormatLabel, resourceAddresses] of [["MP4", progressiveSourceAddresses], ["HLS", selectedMediaDescriptor.hls_urls || []]]) {
      for (const resourceAddress of resourceAddresses) {
        if (seenSourceAddresses.has(resourceAddress)) continue;
        seenSourceAddresses.add(resourceAddress);
        const resolutionCapture = new URL(resourceAddress).pathname.match(/\/(\d{2,5})x(\d{2,5})(?:\/|$)/);
        const variantBitrate = Number(variantMetadataLookup.get(resourceAddress)?.bitrate);
        const addressSegments = [containerFormatLabel];
        if (resolutionCapture) addressSegments.push(`${resolutionCapture[1]} × ${resolutionCapture[2]}`);
        if (variantBitrate > 0) addressSegments.push(variantBitrate >= 1000000 ? `${Number((variantBitrate / 1000000).toFixed(2))} Mbps` : `${Math.round(variantBitrate / 1000)} kbps`);
        if (containerFormatLabel === "HLS") addressSegments.push("播放列表 · 需要分片合并");
        sourceChoiceDescriptors.push({
          url: resourceAddress,
          format: containerFormatLabel,
          label: addressSegments.join(" · ")
        });
      }
    }
    return sourceChoiceDescriptors;
  }
  async function copyAddressToClipboard(displayText) {
    if (typeof GM === "object" && GM && typeof GM.setClipboard === "function") {
      try {
        await GM.setClipboard(displayText, "text");
        return;
      } catch (caughtFailure) {}
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(displayText);
        return;
      } catch (caughtFailure) {}
    }
    const previousFocusedElement = document.activeElement;
    const clipboardFallbackInput = document.createElement("textarea");
    clipboardFallbackInput.value = displayText;
    clipboardFallbackInput.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;";
    clipboardFallbackInput.setAttribute("aria-label", "复制视频地址");
    document.body.append(clipboardFallbackInput);
    try {
      clipboardFallbackInput.focus({
        preventScroll: true
      });
      clipboardFallbackInput.select();
      if (!document.execCommand("copy")) throw new Error("浏览器拒绝了剪贴板写入。");
    } finally {
      clipboardFallbackInput.remove();
      previousFocusedElement?.focus({
        preventScroll: true
      });
    }
  }
  async function requestMediaBlob(resourceAddress, notifyTransferProgress = transferUpdate => console.log(transferUpdate), {
    video: videoElement = false,
    taskId: downloadTaskKey
  } = {}) {
    try {
      let receivedResponse = await performPageRequest(resourceAddress, {});
      if (videoElement) downloadDiagnostics.info(downloadTaskKey, "MP4 服务器返回响应", {
        status: receivedResponse.status,
        contentType: receivedResponse.headers.get("content-type"),
        contentLength: receivedResponse.headers.get("content-length")
      });
      if (videoElement && (!receivedResponse.ok || receivedResponse.status === 206)) {
        void receivedResponse.body?.cancel().catch(() => {});
        const failureCause = new Error(`Video server HTTP ${receivedResponse.status} ${receivedResponse.statusText}`.trim());
        failureCause.status = receivedResponse.status;
        throw failureCause;
      }
      const resourceModifiedHeader = receivedResponse.headers.get("last-modified");
      const responseMediaType = receivedResponse.headers.get("content-type");
      const receivedMimeType = responseMediaType?.split(";")[0].trim().toLowerCase();
      if (videoElement && receivedMimeType && receivedMimeType !== "video/mp4" && receivedMimeType !== "application/octet-stream") {
        void receivedResponse.body?.cancel().catch(() => {});
        throw new Error(`Expected an MP4 video, received ${receivedMimeType}.`);
      }
      const transferSizeDetails = describeResponseProgress(receivedResponse);
      const resourceModifiedDate = formatCalendarDate(resourceModifiedHeader || new Date(), calendarOutputPattern);
      const outputFileSuffix = videoElement ? "mp4" : responseMediaType ? deriveFileSuffix(responseMediaType) : null;
      if (notifyTransferProgress) {
        receivedResponse = await observeResponseBytes(receivedResponse, notifyTransferProgress);
      }
      const downloadPayload = await receivedResponse.blob();
      if (videoElement) {
        const containerSignatureBytes = new Uint8Array(await downloadPayload.slice(0, 12).arrayBuffer());
        if (String.fromCharCode(...containerSignatureBytes.slice(4, 8)) !== "ftyp") {
          throw new Error("The server response is not an MP4 file.");
        }
        if (transferSizeDetails.lengthComputable && transferSizeDetails.total > 0 && downloadPayload.size !== transferSizeDetails.total) {
          throw new Error(`Incomplete video: received ${downloadPayload.size} of ${transferSizeDetails.total} bytes.`);
        }
      }
      const normalizedResourceLocation = new URL(resourceAddress);
      const {
        filename: outputBasename
      } = (normalizedResourceLocation.origin + normalizedResourceLocation.pathname).match(/(?<filename>[^\/]+$)/).groups;
      const {
        name: entryName
      } = outputBasename.match(/(?<name>^[^.]+)/).groups;
      return {
        blob: downloadPayload,
        lastModifiedDate: resourceModifiedDate,
        contentType: responseMediaType,
        extension: outputFileSuffix,
        name: entryName,
        status: receivedResponse.status
      };
    } catch (failureCause) {
      traceEnabled && console.error("[ujs][fetchResource]", resourceAddress);
      traceEnabled && console.error("[ujs][fetchResource]", failureCause);
      throw failureCause;
    }
  }
  async function resolveAndFetchVideo(selectedMediaDescriptor, notifyTransferProgress = null, downloadTaskKey) {
    const resourceAddresses = [...new Set(selectedMediaDescriptor.download_urls || (selectedMediaDescriptor.download_url ? [selectedMediaDescriptor.download_url] : []))];
    downloadDiagnostics.links(downloadTaskKey, selectedMediaDescriptor);
    downloadDiagnostics.info(downloadTaskKey, "准备下载候选地址", {
      mp4Count: resourceAddresses.length,
      hlsCount: selectedMediaDescriptor.hls_urls?.length || 0
    });
    const attemptFailureMessages = [];
    for (const resourceAddress of resourceAddresses) {
      for (let requestAttempt = 0; requestAttempt < 2; requestAttempt++) {
        downloadDiagnostics.info(downloadTaskKey, "尝试 MP4 下载", {
          url: downloadDiagnostics.url(resourceAddress),
          attempt: requestAttempt + 1
        });
        const transferObserver = downloadDiagnostics.monitor(downloadTaskKey, "MP4 下载");
        try {
          const forwardTransferUpdate = transferUpdate => {
            transferObserver.progress(transferUpdate);
            notifyTransferProgress?.(transferUpdate);
          };
          forwardTransferUpdate({
            loaded: 0,
            total: 0
          });
          const resolvedResult = await requestMediaBlob(resourceAddress, forwardTransferUpdate, {
            video: true,
            taskId: downloadTaskKey
          });
          downloadDiagnostics.info(downloadTaskKey, "MP4 数据获取完成", {
            sizeBytes: resolvedResult.blob.size
          });
          return {
            ...resolvedResult,
            url: resourceAddress
          };
        } catch (failureCause) {
          downloadDiagnostics.warn(downloadTaskKey, "MP4 尝试失败", downloadDiagnostics.errorDetails(failureCause));
          const isRecoverableRequestFailure = failureCause instanceof TypeError || failureCause.status === 408 || failureCause.status >= 500;
          if (requestAttempt === 0 && isRecoverableRequestFailure) {
            downloadDiagnostics.info(downloadTaskKey, "500ms 后重试当前 MP4 地址");
            await waitForMilliseconds(500);
            continue;
          }
          attemptFailureMessages.push(failureCause.message);
          break;
        } finally {
          transferObserver.stop();
        }
      }
    }
    for (const resourceAddress of selectedMediaDescriptor.hls_urls || []) {
      downloadDiagnostics.info(downloadTaskKey, "尝试 HLS 分片下载与合并", {
        url: downloadDiagnostics.url(resourceAddress)
      });
      const transferObserver = downloadDiagnostics.monitor(downloadTaskKey, "HLS 下载与合并");
      try {
        const forwardTransferUpdate = transferUpdate => {
          transferObserver.progress(transferUpdate);
          notifyTransferProgress?.(transferUpdate);
        };
        forwardTransferUpdate({
          loaded: 0,
          total: 0
        });
        return await assembleStreamingVideo(resourceAddress, forwardTransferUpdate, downloadTaskKey);
      } catch (failureCause) {
        downloadDiagnostics.warn(downloadTaskKey, "HLS 尝试失败", downloadDiagnostics.errorDetails(failureCause));
        attemptFailureMessages.push(failureCause.message);
      } finally {
        transferObserver.stop();
      }
    }
    throw new Error(attemptFailureMessages.length ? [...new Set(attemptFailureMessages)].join("\n") : "This video has no accessible MP4 or HLS URL. Check login and tweet visibility, then reload the page.");
  }
  async function assembleStreamingVideo(resourceAddress, notifyTransferProgress, downloadTaskKey) {
    if (typeof Mediabunny === "undefined") {
      throw new Error("HLS support is unavailable. Reinstall this userscript so its required media library is loaded.");
    }
    const {
      Input: MediaInputSession,
      UrlSource: RemoteMediaSource,
      HLS_FORMATS: STREAMING_INPUT_FORMATS,
      Output: MediaOutputSession,
      Mp4OutputFormat: MovieContainerWriter,
      StreamTarget: ChunkedOutputTarget,
      Conversion: MediaRemuxSession
    } = Mediabunny;
    const streamingInputSession = new MediaInputSession({
      formats: STREAMING_INPUT_FORMATS,
      source: new RemoteMediaSource(resourceAddress, {
        fetchFn: async (requestedResource, requestConfiguration) => {
          const receivedResponse = await performPageRequest(typeof requestedResource === "string" ? requestedResource : requestedResource.url || String(requestedResource), requestConfiguration);
          if (!receivedResponse.ok) {
            downloadDiagnostics.warn(downloadTaskKey, "HLS 子请求失败", {
              url: downloadDiagnostics.url(requestedResource),
              status: receivedResponse.status
            });
            void receivedResponse.body?.cancel().catch(() => {});
            const failureCause = new Error(`HLS server HTTP ${receivedResponse.status}`);
            failureCause.status = receivedResponse.status;
            throw failureCause;
          }
          return receivedResponse;
        },
        maxCacheSize: 16 * 1024 * 1024,
        getRetryDelay: (failedAttemptCount, failureCause) => {
          if (failedAttemptCount >= 2 || failureCause?.status >= 400 && failureCause.status < 500 && failureCause.status !== 408) {
            return null;
          }
          downloadDiagnostics.warn(downloadTaskKey, "HLS 子请求准备重试", {
            attempt: failedAttemptCount + 1,
            ...downloadDiagnostics.errorDetails(failureCause)
          });
          return 0.5 * (failedAttemptCount + 1);
        }
      })
    });
    let remuxOperation;
    try {
      const selectedVideoTrack = await streamingInputSession.getPrimaryVideoTrack();
      const selectedAudioTrack = await streamingInputSession.getPrimaryAudioTrack();
      downloadDiagnostics.info(downloadTaskKey, "HLS 轨道识别完成", {
        hasVideo: Boolean(selectedVideoTrack),
        hasAudio: Boolean(selectedAudioTrack)
      });
      if (!selectedVideoTrack) {
        throw new Error("The HLS playlist has no video track.");
      }
      const selectedTracks = [selectedVideoTrack, selectedAudioTrack].filter(Boolean);
      if ((await Promise.all(selectedTracks.map(selectedTrack => selectedTrack.isLive()))).some(Boolean)) {
        throw new Error("This video is still live. Retry after the broadcast has ended.");
      }
      const payloadFragments = [];
      let measuredByteCount = 0;
      const streamingOutputSession = new MediaOutputSession({
        format: new MovieContainerWriter({
          fastStart: "fragmented"
        }),
        target: new ChunkedOutputTarget(new WritableStream({
          write({
            data: outputChunkBytes,
            position: outputWriteOffset
          }) {
            if (outputWriteOffset !== measuredByteCount) {
              throw new Error("Unexpected non-sequential MP4 output.");
            }
            payloadFragments.push(new Blob([outputChunkBytes]));
            measuredByteCount += outputChunkBytes.byteLength;
          }
        }), {
          chunked: true,
          chunkSize: 4 * 1024 * 1024
        })
      });
      remuxOperation = await MediaRemuxSession.init({
        input: streamingInputSession,
        output: streamingOutputSession,
        tracks: "primary",
        copy: {
          mode: "forced"
        },
        showWarnings: false
      });
      if (!remuxOperation.isValid || selectedTracks.some(selectedTrack => !remuxOperation.utilizedTracks.includes(selectedTrack))) {
        throw new Error("The HLS audio/video codecs cannot be saved together as MP4 without transcoding.");
      }
      remuxOperation.onProgress = completionRatio => notifyTransferProgress?.({
        loaded: measuredByteCount,
        total: 0,
        progress: completionRatio
      });
      downloadDiagnostics.info(downloadTaskKey, "开始下载 HLS 数据并合并 MP4");
      await remuxOperation.execute();
      const downloadPayload = new Blob(payloadFragments, {
        type: "video/mp4"
      });
      if (!downloadPayload.size) {
        throw new Error("The HLS download produced an empty video.");
      }
      notifyTransferProgress?.({
        loaded: downloadPayload.size,
        total: downloadPayload.size,
        progress: 1
      });
      downloadDiagnostics.info(downloadTaskKey, "HLS 合并完成", {
        sizeBytes: downloadPayload.size
      });
      const entryName = new URL(resourceAddress).pathname.split("/").pop().replace(/\.m3u8$/i, "") || "video";
      return {
        blob: downloadPayload,
        lastModifiedDate: formatCalendarDate(new Date(), calendarOutputPattern),
        extension: "mp4",
        name: entryName,
        url: resourceAddress
      };
    } finally {
      if (remuxOperation && remuxOperation.state !== "done") {
        await remuxOperation.cancel().catch(() => {});
      }
      streamingInputSession.dispose();
    }
  }
  function deriveFileSuffix(declaredMimeType) {
    let outputFileSuffix = declaredMimeType.split(";")[0].trim().match(/(?<=\/).+/)[0];
    outputFileSuffix = outputFileSuffix === "jpeg" ? "jpg" : outputFileSuffix;
    return outputFileSuffix;
  }
  function savePayloadToDevice(downloadPayload, entryName, resourceAddress, downloadTaskKey) {
    if (downloadTaskKey) downloadDiagnostics.info(downloadTaskKey, "准备触发浏览器保存", {
      filename: entryName,
      sizeBytes: downloadPayload.size
    });
    const hyperlinkElement = document.createElement("a");
    hyperlinkElement.setAttribute("download", entryName || "");
    const temporaryObjectAddress = URL.createObjectURL(downloadPayload);
    hyperlinkElement.href = temporaryObjectAddress + (resourceAddress ? "#" + resourceAddress : "");
    hyperlinkElement.click();
    if (downloadTaskKey) downloadDiagnostics.info(downloadTaskKey, "已触发浏览器保存，请在下载列表（Ctrl+J）确认", {
      filename: entryName,
      note: "网页无法确认文件是否最终写入磁盘，也无法检测浏览器是否拦截了保存操作。"
    });
    setTimeout(() => URL.revokeObjectURL(temporaryObjectAddress), 30000);
  }
  function formatCalendarDate(calendarInputValue = new Date(), calendarTokenPattern = "YYYY.MM.DD", useUniversalTime = true) {
    calendarInputValue = normalizeFirefoxDateInput(calendarInputValue);
    const calendarDate = new Date(calendarInputValue);
    if (calendarDate.toString() === "Invalid Date") {
      console.warn("Invalid Date value: ", calendarInputValue);
    }
    const calendarTokenReader = new CalendarTokenReader(calendarDate, useUniversalTime);
    return calendarTokenPattern.replaceAll(/YYYY|YY|MM|DD|hh|mm|ss/g, (...invocationArguments) => {
      const calendarComponentKey = invocationArguments[0];
      return calendarTokenReader[calendarComponentKey];
    });
  }
  function normalizeFirefoxDateInput(calendarInputValue) {
    if (isTextValue(calendarInputValue)) {
      return calendarInputValue.replace(/(?<y>\d{4})\.(?<m>\d{2})\.(?<d>\d{2})/, "$<y>-$<m>-$<d>");
    }
    return calendarInputValue;
  }
  function isTextValue(entryContent) {
    return typeof entryContent === "string";
  }
  function padCalendarComponent(entryContent, entryCount = 2) {
    return entryContent.toString().padStart(entryCount, "0");
  }
  class CalendarTokenReader {
    constructor(calendarDate = new Date(), useUniversalTime = true) {
      this.date = calendarDate;
      this.utc = useUniversalTime ? "UTC" : "";
    }
    get ss() {
      return padCalendarComponent(this.date[`get${this.utc}Seconds`]());
    }
    get mm() {
      return padCalendarComponent(this.date[`get${this.utc}Minutes`]());
    }
    get hh() {
      return padCalendarComponent(this.date[`get${this.utc}Hours`]());
    }
    get DD() {
      return padCalendarComponent(this.date[`get${this.utc}Date`]());
    }
    get MM() {
      return padCalendarComponent(this.date[`get${this.utc}Month`]() + 1);
    }
    get YYYY() {
      return padCalendarComponent(this.date[`get${this.utc}FullYear`](), 4);
    }
    get YY() {
      return this.YYYY.slice(2);
    }
  }
  function insertPageStyles(stylesheetRules) {
    const injectedStylesheet = document.createElement("style");
    injectedStylesheet.textContent = stylesheetRules;
    document.body.append(injectedStylesheet);
    return injectedStylesheet;
  }
  function readCookieValue(entryName) {
    traceEnabled && console.log("[ujs][getCookie]", document.cookie);
    const matchingExpression = new RegExp(`(?<=${entryName}=)[^;]+`);
    return document.cookie.match(matchingExpression)?.[0];
  }
  function limitInvocationFrequency(deferredAction, delayMilliseconds = 50) {
    let invocationCoolingDown = false;
    let invocationQueued = false;
    let invocationReceiver;
    let invocationArguments;
    return function () {
      if (!invocationCoolingDown) {
        invocationCoolingDown = true;
        setTimeout(function () {
          if (invocationQueued) {
            deferredAction.apply(invocationReceiver, invocationArguments);
            invocationReceiver = invocationArguments = undefined;
          }
          invocationCoolingDown = invocationQueued = false;
        }, delayMilliseconds);
        return deferredAction.apply(this, arguments);
      } else {
        invocationQueued = true;
        invocationReceiver = this;
        invocationArguments = arguments;
      }
    };
  }
  function coalescePendingResult(wrappedCallable, delayMilliseconds = 50) {
    let invocationCoolingDown = false;
    let invocationArguments;
    let invocationReceiver;
    let invocationCooldown;
    let pendingInvocationResult;
    return async function () {
      if (!invocationCoolingDown) {
        invocationCoolingDown = true;
        invocationCooldown = new Promise(async fulfillPendingPromise => {
          await waitForMilliseconds(delayMilliseconds);
          invocationCoolingDown = false;
          fulfillPendingPromise();
        });
        return wrappedCallable.apply(this, arguments);
      } else {
        invocationArguments = arguments;
        invocationReceiver = this;
      }
      if (!pendingInvocationResult) {
        pendingInvocationResult = new Promise(async fulfillPendingPromise => {
          await invocationCooldown;
          const resolvedResult = wrappedCallable.apply(invocationReceiver, invocationArguments);
          invocationArguments = invocationReceiver = pendingInvocationResult = undefined;
          fulfillPendingPromise(resolvedResult);
        });
      }
      return pendingInvocationResult;
    };
  }
  function findXpathNode(xpathExpression, traversedNode = document) {
    let xpathEvaluationResult = document.evaluate(xpathExpression, traversedNode, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return xpathEvaluationResult.singleNodeValue;
  }
  function findAllXpathNodes(xpathExpression, traversedNode = document) {
    let xpathEvaluationResult = document.evaluate(xpathExpression, traversedNode, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    const traversedNodes = [];
    try {
      let traversedNode = xpathEvaluationResult.iterateNext();
      while (traversedNode) {
        traversedNodes.push(traversedNode);
        traversedNode = xpathEvaluationResult.iterateNext();
      }
      return traversedNodes;
    } catch (caughtFailure) {
      console.error(caughtFailure);
      return [];
    }
  }
  const UNCOMPRESSED_ENCODING_LABELS = new Set([null, "identity", "no encoding"]);
  function describeResponseProgress(receivedResponse) {
    const {
      headers: requestHeaderBag,
      status: operationStatus,
      statusText: responseStatusLabel,
      url: resourceAddress,
      redirected: responseWasRedirected,
      ok: responseSucceeded
    } = receivedResponse;
    const isUncompressedResponse = UNCOMPRESSED_ENCODING_LABELS.has(requestHeaderBag.get("Content-Encoding"));
    const isEncodedPayload = !isUncompressedResponse;
    const declaredLengthHeader = parseInt(requestHeaderBag.get("Content-Length"));
    const declaredByteCount = isNaN(declaredLengthHeader) ? null : declaredLengthHeader;
    const hasMeasurableLength = isUncompressedResponse && declaredByteCount !== null && declaredByteCount >= 0;
    const expectedTotalCount = hasMeasurableLength ? declaredByteCount : 0;
    const userscriptTotalByteCount = declaredByteCount > 0 ? declaredByteCount : -1;
    return {
      gmTotal: userscriptTotalByteCount,
      total: expectedTotalCount,
      lengthComputable: hasMeasurableLength,
      compressed: isEncodedPayload,
      contentLength: declaredByteCount,
      headers: requestHeaderBag,
      status: operationStatus,
      statusText: responseStatusLabel,
      url: resourceAddress,
      redirected: responseWasRedirected,
      ok: responseSucceeded
    };
  }
  async function observeResponseBytes(receivedResponse, notifyTransferProgress) {
    const responseProgressDetails = describeResponseProgress(receivedResponse);
    let transferredByteCount = 0;
    let responseStreamReader;
    try {
      responseStreamReader = receivedResponse.body?.getReader();
    } catch (caughtFailure) {
      traceEnabled && console.warn("[ujs][progress-unavailable]", caughtFailure);
      return receivedResponse;
    }
    if (!responseStreamReader) {
      return receivedResponse;
    }
    if (firefoxBrowserDetected) {
      const payloadFragments = [];
      try {
        while (true) {
          const {
            done: streamHasEnded,
            value: receivedChunk
          } = await responseStreamReader.read();
          if (streamHasEnded) {
            break;
          }
          transferredByteCount += receivedChunk.length;
          payloadFragments.push(receivedChunk);
          try {
            notifyTransferProgress({
              loaded: transferredByteCount,
              ...responseProgressDetails
            });
          } catch (caughtFailure) {
            console.error("[ujs][onProgress]:", caughtFailure);
          }
        }
        return new TrackedFetchResponse(new Blob(payloadFragments), receivedResponse);
      } finally {
        responseStreamReader.releaseLock();
      }
    }
    const proxiedResponseStream = new ReadableStream({
      async pull(streamOutputController) {
        try {
          const {
            done: streamHasEnded,
            value: receivedChunk
          } = await responseStreamReader.read();
          if (streamHasEnded) {
            streamOutputController.close();
            responseStreamReader.releaseLock();
            return;
          }
          transferredByteCount += receivedChunk.length;
          try {
            notifyTransferProgress({
              loaded: transferredByteCount,
              ...responseProgressDetails
            });
          } catch (caughtFailure) {
            console.error("[ujs][onProgress]:", caughtFailure);
          }
          streamOutputController.enqueue(receivedChunk);
        } catch (caughtFailure) {
          streamOutputController.error(caughtFailure);
          responseStreamReader.releaseLock();
        }
      },
      async cancel(streamCancellationReason) {
        try {
          await responseStreamReader.cancel(streamCancellationReason);
        } finally {
          responseStreamReader.releaseLock();
        }
      }
    });
    return new TrackedFetchResponse(proxiedResponseStream, receivedResponse);
  }
  class TrackedFetchResponse extends Response {
    [Symbol.toStringTag] = "ResponseEx";
    constructor(responsePayload, {
      headers: requestHeaderBag,
      status: operationStatus,
      statusText: responseStatusLabel,
      url: resourceAddress,
      redirected: responseWasRedirected,
      type: mediaCategory,
      ok: responseSucceeded
    }) {
      super(responsePayload, {
        status: operationStatus,
        statusText: responseStatusLabel,
        headers: {
          ...requestHeaderBag,
          "content-type": requestHeaderBag.get("content-type")?.split("; ")[0]
        }
      });
      this._type = mediaCategory;
      this._url = resourceAddress;
      this._redirected = responseWasRedirected;
      this._ok = responseSucceeded;
      this._headers = requestHeaderBag;
    }
    get redirected() {
      return this._redirected;
    }
    get url() {
      return this._url;
    }
    get type() {
      return this._type || "basic";
    }
    get ok() {
      return this._ok;
    }
    get headers() {
      return this._headers;
    }
  }
  function serializeHistoryDocument(serializableDocument, expandFirstJsonProperty = false) {
    let resolvedResult = "{\n";
    const propertyEntries = Object.entries(serializableDocument);
    const collectionLength = propertyEntries.length;
    if (expandFirstJsonProperty && collectionLength > 0) {
      resolvedResult += `"${propertyEntries[0][0]}":${JSON.stringify(propertyEntries[0][1], null, " ")}`;
      if (collectionLength > 1) {
        resolvedResult += `,\n\n`;
      }
    }
    for (let entryCursor = 1; entryCursor < collectionLength - 1; entryCursor++) {
      resolvedResult += `"${propertyEntries[entryCursor][0]}":${JSON.stringify(propertyEntries[entryCursor][1])},\n`;
    }
    if (collectionLength > 0 && !expandFirstJsonProperty || collectionLength > 1) {
      resolvedResult += `"${propertyEntries[collectionLength - 1][0]}":${JSON.stringify(propertyEntries[collectionLength - 1][1])}`;
    }
    resolvedResult += `\n}`;
    return resolvedResult;
  }
  const firefoxSandboxDetected = typeof wrappedJSObject === "object" && wrappedJSObject !== null;
  const firefoxBrowserDetected = navigator.userAgent.toLowerCase().indexOf("firefox") !== -1;
  traceEnabled && console.log("[ujs] isFirefoxUserscriptContext", firefoxSandboxDetected);
  function detectBrowserFamily() {
    const browserAgentText = window.navigator.userAgent.toLowerCase();
    return browserAgentText.indexOf("edge") > -1 ? "edge-legacy" : browserAgentText.indexOf("edg") > -1 ? "edge" : browserAgentText.indexOf("opr") > -1 && !!window.opr ? "opera" : browserAgentText.indexOf("chrome") > -1 && !!window.chrome ? "chrome" : browserAgentText.indexOf("firefox") > -1 ? "firefox" : browserAgentText.indexOf("safari") > -1 ? "safari" : "";
  }
  function stripAddressQuery(resourceAddress) {
    const parsedResourceAddress = new URL(resourceAddress);
    const searchParameterNames = [];
    parsedResourceAddress.searchParams.forEach((searchParameterValue, searchParameterName) => {
      searchParameterNames.push(searchParameterName);
    });
    for (const propertyName of searchParameterNames) {
      parsedResourceAddress.searchParams.delete(propertyName);
    }
    return parsedResourceAddress.toString();
  }
  function fillFilenamePattern(filenamePatternText, transferUpdate) {
    let containsMissingField = false;
    const entryContent = filenamePatternText.replaceAll(/{[^{}]+?}/g, (matchedEntry, entryPosition, replacementInputText) => {
      const propertyName = matchedEntry.slice(1, -1);
      const replacementFieldValue = transferUpdate[propertyName];
      if (replacementFieldValue === undefined) {
        containsMissingField = true;
      }
      return replacementFieldValue;
    });
    return {
      value: entryContent,
      hasUndefined: containsMissingField
    };
  }
  function formatReadableByteCount(byteQuantity) {
    if (byteQuantity < 1024) {
      return byteQuantity + " B";
    }
    const BYTE_UNIT_LABELS = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    let entryCursor = Math.floor(Math.log(byteQuantity) / Math.log(1024));
    let resolvedResult = byteQuantity / Math.pow(1024, entryCursor);
    if (resolvedResult >= 1000) {
      entryCursor++;
      resolvedResult /= 1024;
    }
    return truncateToThreeSignificantDigits(resolvedResult) + " " + BYTE_UNIT_LABELS[entryCursor];
  }
  function truncateToThreeSignificantDigits(precisionInput) {
    let resolvedResult;
    if (precisionInput < 10) {
      resolvedResult = Math.trunc(precisionInput * 100) / 100;
    } else if (precisionInput < 100) {
      resolvedResult = Math.trunc(precisionInput * 10) / 10;
    } else if (precisionInput < 1000) {
      resolvedResult = Math.trunc(precisionInput);
    } else {
      return Math.trunc(precisionInput).toString();
    }
    if (precisionInput < 0.1) {
      return resolvedResult.toPrecision(1);
    } else if (precisionInput < 1) {
      return resolvedResult.toPrecision(2);
    }
    return resolvedResult.toPrecision(3);
  }
  return {
    sleep: waitForMilliseconds,
    fetchResource: requestMediaBlob,
    fetchVideoResource: resolveAndFetchVideo,
    extensionFromMime: deriveFileSuffix,
    downloadBlob: savePayloadToDevice,
    formatDate: formatCalendarDate,
    addCSS: insertPageStyles,
    getCookie: readCookieValue,
    throttle: limitInvocationFrequency,
    throttleWithResult: coalescePendingResult,
    xpath: findXpathNode,
    xpathAll: findAllXpathNodes,
    responseProgressProxy: observeResponseBytes,
    toLineJSON: serializeHistoryDocument,
    isFirefox: firefoxBrowserDetected,
    isFirefoxUserscriptContext: firefoxSandboxDetected,
    getBrowserName: detectBrowserFamily,
    removeSearchParams: stripAddressQuery,
    renderTemplateString: fillFilenamePattern,
    formatSizeWinLike: formatReadableByteCount,
    getVideoLinkOptions: describeVideoSourceChoices,
    copyText: copyAddressToClipboard
  };
}
