"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");
const { pathToFileURL } = require("url");

const defaultCodexPetAdapter = require("./codex-pet-adapter");
const defaultCodexPetImporter = require("./codex-pet-importer");

const REGISTER_PROTOCOL_DEV_ARG = "--register-protocol";
const CLAWD_PROTOCOL_SCHEME = "roary";

function emptyCodexPetSyncSummary(overrides = {}) {
  return {
    codexPetsDir: "",
    userThemesDir: "",
    imported: 0,
    updated: 0,
    unchanged: 0,
    invalid: 0,
    removed: 0,
    activeOrphanThemeIds: [],
    themes: [],
    diagnostics: [],
    ...overrides,
  };
}

function mergeCodexPetSyncSummaries(base, extra) {
  const a = base || emptyCodexPetSyncSummary();
  const b = extra || emptyCodexPetSyncSummary();
  return {
    codexPetsDir: b.codexPetsDir || a.codexPetsDir || "",
    userThemesDir: b.userThemesDir || a.userThemesDir || "",
    imported: (a.imported || 0) + (b.imported || 0),
    updated: (a.updated || 0) + (b.updated || 0),
    unchanged: (a.unchanged || 0) + (b.unchanged || 0),
    invalid: (a.invalid || 0) + (b.invalid || 0),
    removed: (a.removed || 0) + (b.removed || 0),
    activeOrphanThemeIds: [
      ...new Set([
        ...((a.activeOrphanThemeIds || []).map(String)),
        ...((b.activeOrphanThemeIds || []).map(String)),
      ]),
    ],
    themes: [
      ...(Array.isArray(a.themes) ? a.themes : []),
      ...(Array.isArray(b.themes) ? b.themes : []),
    ],
    diagnostics: [
      ...(Array.isArray(a.diagnostics) ? a.diagnostics : []),
      ...(Array.isArray(b.diagnostics) ? b.diagnostics : []),
    ],
    error: a.error || b.error || null,
  };
}

function summaryHasActiveCodexPetOrphan(summary, themeId) {
  return !!(
    themeId
    && summary
    && Array.isArray(summary.activeOrphanThemeIds)
    && summary.activeOrphanThemeIds.includes(themeId)
  );
}

function sameFsPath(a, b, pathModule = defaultPath) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = pathModule.resolve(a);
  const right = pathModule.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isFsPathInsideDir(rootDir, candidatePath, pathModule = defaultPath) {
  if (typeof rootDir !== "string" || typeof candidatePath !== "string") return false;
  let root = pathModule.resolve(rootDir);
  let candidate = pathModule.resolve(candidatePath);
  if (process.platform === "win32") {
    root = root.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  return candidate !== root && candidate.startsWith(root + pathModule.sep);
}

function extractClawdProtocolUrls(argv) {
  if (!Array.isArray(argv)) return [];
  return argv.filter((arg) => typeof arg === "string" && arg.toLowerCase().startsWith(`${CLAWD_PROTOCOL_SCHEME}:`));
}

function requiredDependency(value, name) {
  if (!value) throw new Error(`createCodexPetMain requires ${name}`);
  return value;
}

function createCodexPetMain(options = {}) {
  const app = requiredDependency(options.app, "app");
  const dialog = requiredDependency(options.dialog, "dialog");
  const shell = requiredDependency(options.shell, "shell");
  const themeLoader = requiredDependency(options.themeLoader, "themeLoader");
  const settingsController = requiredDependency(options.settingsController, "settingsController");
  const BrowserWindow = options.BrowserWindow || null;
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const codexPetAdapter = options.codexPetAdapter || defaultCodexPetAdapter;
  const codexPetImporter = options.codexPetImporter || defaultCodexPetImporter;

  const pendingImportUrls = [];
  let importFlushRunning = false;
  let lastSyncSummary = null;

  function getActiveThemeId() {
    const activeTheme = typeof options.getActiveTheme === "function" ? options.getActiveTheme() : null;
    return activeTheme ? activeTheme._id : (settingsController.get("theme") || "clawd");
  }

  function getDialogParent() {
    const settingsWindow = typeof options.getSettingsWindow === "function" ? options.getSettingsWindow() : null;
    if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow;
    const mainWindow = typeof options.getMainWindow === "function" ? options.getMainWindow() : null;
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    return null;
  }

  function rebuildMenusBestEffort(optionsForRebuild = {}) {
    if (typeof options.rebuildAllMenus !== "function") return;
    try {
      options.rebuildAllMenus();
    } catch (err) {
      if (optionsForRebuild.logFailure === false) return;
      console.warn("Roary: rebuildAllMenus after Codex Pet refresh failed:", err && err.message);
    }
  }

  function getLang() {
    if (typeof options.getLang === "function") return options.getLang() || "en";
    return settingsController.get("lang") || "en";
  }

  function syncThemes(activeThemeId) {
    try {
      const summary = codexPetAdapter.syncCodexPetThemes({
        userDataDir: app.getPath("userData"),
        activeThemeId,
      });
      lastSyncSummary = summary;
      return summary;
    } catch (err) {
      const summary = emptyCodexPetSyncSummary({
        error: err && err.message ? err.message : String(err),
        diagnostics: [{ errors: [`failed to sync Codex Pet themes: ${err && err.message ? err.message : err}`] }],
      });
      lastSyncSummary = summary;
      console.warn("Roary: failed to sync Codex Pet themes:", err && err.message);
      return summary;
    }
  }

  function setLastSyncSummary(summary) {
    lastSyncSummary = summary;
  }

  function reloadActiveThemeIfUpdated(summary, activeThemeId) {
    if (
      !activeThemeId
      || !summary
      || !Array.isArray(summary.themes)
      || typeof options.reloadActiveTheme !== "function"
    ) {
      return false;
    }
    const updatedActiveTheme = summary.themes.some((theme) => (
      theme
      && theme.themeId === activeThemeId
      && theme.operation === "updated"
    ));
    if (!updatedActiveTheme) return false;
    options.reloadActiveTheme();
    return true;
  }

  function getManagedThemeDir(themeId) {
    if (typeof themeId !== "string" || !themeId) return null;
    let userThemesDir;
    try {
      userThemesDir = themeLoader.ensureUserThemesDir();
    } catch {
      return null;
    }
    if (!userThemesDir) return null;
    const root = path.resolve(userThemesDir);
    const themeDir = path.resolve(path.join(userThemesDir, themeId));
    if (!isFsPathInsideDir(root, themeDir, path)) return null;
    return themeDir;
  }

  function readManagedThemeMarker(themeId) {
    const themeDir = getManagedThemeDir(themeId);
    if (!themeDir) return null;
    return codexPetAdapter.readManagedMarker(themeDir);
  }

  function getPreviewAtlasUrl(themeId, marker) {
    const themeDir = getManagedThemeDir(themeId);
    if (!themeDir || !marker || typeof marker.sourceSpritesheetPath !== "string") return null;
    const filename = path.basename(marker.sourceSpritesheetPath);
    if (!filename) return null;
    const assetsDir = path.resolve(path.join(themeDir, "assets"));
    const atlasPath = path.resolve(path.join(assetsDir, filename));
    if (!isFsPathInsideDir(assetsDir, atlasPath, path) || !fs.existsSync(atlasPath)) return null;
    try {
      return pathToFileURL(atlasPath).href;
    } catch {
      return null;
    }
  }

  function decorateThemeMetadata(theme) {
    const marker = theme && readManagedThemeMarker(theme.id);
    if (!marker) return theme;
    return {
      ...theme,
      managedCodexPet: true,
      codexPet: {
        sourcePetId: marker.sourcePetId || "",
        sourcePackagePath: marker.sourcePackagePath || "",
        previewAtlasUrl: getPreviewAtlasUrl(theme.id, marker),
        adapterVersion: marker.adapterVersion || 0,
      },
    };
  }

  async function refreshFromSettings() {
    const activeId = getActiveThemeId();
    let summary = syncThemes(activeId);
    let switchedToFallback = false;

    if (summary.error) {
      return { status: "error", message: summary.error, summary };
    }

    if (summaryHasActiveCodexPetOrphan(summary, activeId)) {
      const result = await settingsController.applyCommand("setThemeSelection", { themeId: "clawd" });
      if (!result || result.status !== "ok") {
        return {
          status: "error",
          message: (result && result.message) || "failed to switch active orphan Codex Pet theme back to clawd",
          summary,
        };
      }
      switchedToFallback = true;
      const cleanup = syncThemes("clawd");
      summary = mergeCodexPetSyncSummaries(summary, cleanup);
      lastSyncSummary = summary;
      if (cleanup.error) {
        return { status: "error", message: cleanup.error, summary, switchedToFallback };
      }
    }

    try {
      reloadActiveThemeIfUpdated(summary, activeId);
    } catch (err) {
      return {
        status: "error",
        message: (err && err.message) || String(err),
        summary,
        switchedToFallback,
      };
    }

    rebuildMenusBestEffort();
    return { status: "ok", summary, switchedToFallback };
  }

  function resolveRemovalTarget(themeId) {
    const marker = readManagedThemeMarker(themeId);
    if (!marker) {
      return { status: "error", message: "theme is not a managed Codex Pet" };
    }
    const petsRoot = path.resolve(codexPetImporter.getDefaultCodexPetsDir());
    const packageDir = path.resolve(marker.sourcePackagePath || "");
    if (!isFsPathInsideDir(petsRoot, packageDir, path) || !sameFsPath(path.dirname(packageDir), petsRoot, path)) {
      return { status: "error", message: "managed Codex Pet source path is outside the pets folder" };
    }
    return {
      status: "ok",
      marker,
      packageDir,
      exists: fs.existsSync(packageDir),
    };
  }

  function enqueueImportUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return;
    pendingImportUrls.push(rawUrl);
    if (app.isReady()) {
      setImmediate(() => {
        flushPendingImportUrls().catch((err) => {
          console.warn("Roary: Codex Pet import queue failed:", err && err.message);
        });
      });
    }
  }

  function enqueueImportUrlsFromArgv(argv) {
    for (const rawUrl of extractClawdProtocolUrls(argv)) {
      enqueueImportUrl(rawUrl);
    }
  }

  function registerProtocolClient() {
    try {
      if (app.isPackaged) {
        return app.setAsDefaultProtocolClient(CLAWD_PROTOCOL_SCHEME);
      }
      if (process.argv.includes(REGISTER_PROTOCOL_DEV_ARG) || process.env.CLAWD_REGISTER_PROTOCOL_DEV === "1") {
        const appRoot = path.resolve(__dirname, "..");
        return app.setAsDefaultProtocolClient(CLAWD_PROTOCOL_SCHEME, process.execPath, [appRoot]);
      }
    } catch (err) {
      console.warn("Roary: failed to register roary:// protocol:", err && err.message);
    }
    return false;
  }

  async function flushPendingImportUrls() {
    if (importFlushRunning) return;
    importFlushRunning = true;
    try {
      while (pendingImportUrls.length > 0) {
        const rawUrl = pendingImportUrls.shift();
        await handleImportProtocolUrl(rawUrl);
      }
    } finally {
      importFlushRunning = false;
    }
  }

  function getImportDialogStrings() {
    const all = {
      en: {
        import: "Import",
        cancel: "Cancel",
        ok: "OK",
        confirmMessage: (host) => `Import Codex Pet from ${host}?`,
        confirmDetail: (url) => `Clawd will download, validate, and install this pet package before switching to it.\n\n${url}`,
        replaceMessage: (name) => `Replace existing local pet "${name}"?`,
        replaceDetail: "A Codex Pet package with the same id already exists locally. Replacing it will overwrite that local package.",
        successMessage: (name) => `Imported "${name}"`,
        successDetail: "The imported Codex Pet is now active.",
        failedMessage: "Couldn't import Codex Pet",
      },
      ru: {
        import: "Импортировать",
        cancel: "Отмена",
        ok: "ОК",
        confirmMessage: (host) => `Импортировать Codex Pet с ${host}?`,
        confirmDetail: (url) => `Clawd скачает, проверит и установит этот пакет питомца, а затем переключится на него.\n\n${url}`,
        replaceMessage: (name) => `Заменить существующего локального питомца "${name}"?`,
        replaceDetail: "Пакет Codex Pet с таким же id уже есть локально. Замена перезапишет этот локальный пакет.",
        successMessage: (name) => `Импортирован "${name}"`,
        successDetail: "Импортированный Codex Pet теперь активен.",
        failedMessage: "Не удалось импортировать Codex Pet",
      },
      uk: {
        import: "Імпортувати",
        cancel: "Скасувати",
        ok: "Гаразд",
        confirmMessage: (host) => `Імпортувати Codex Pet з ${host}?`,
        confirmDetail: (url) => `Clawd завантажить, перевірить і встановить цей пакет улюбленця, а потім перемкнеться на нього.\n\n${url}`,
        replaceMessage: (name) => `Замінити наявного локального улюбленця "${name}"?`,
        replaceDetail: "Пакет Codex Pet з таким самим id уже є локально. Заміна перезапише цей локальний пакет.",
        successMessage: (name) => `Імпортовано "${name}"`,
        successDetail: "Імпортований Codex Pet тепер активний.",
        failedMessage: "Не вдалося імпортувати Codex Pet",
      },
    };
    return all[getLang()] || all.en;
  }

  async function showImportError(message) {
    const s = getImportDialogStrings();
    try {
      await dialog.showMessageBox(getDialogParent(), {
        type: "error",
        buttons: [s.ok],
        message: s.failedMessage,
        detail: message || "unknown error",
        noLink: true,
      });
    } catch {}
  }

  async function confirmReplaceExistingPackage(payload) {
    const s = getImportDialogStrings();
    const existing = payload && payload.existingManifest;
    const incoming = payload && payload.incomingManifest;
    const displayName = (incoming && (incoming.displayName || incoming.id))
      || (existing && (existing.displayName || existing.id))
      || (payload && payload.packageName)
      || "Codex Pet";
    try {
      const { response } = await dialog.showMessageBox(getDialogParent(), {
        type: "warning",
        buttons: [s.import, s.cancel],
        defaultId: 1,
        cancelId: 1,
        message: s.replaceMessage(displayName),
        detail: s.replaceDetail,
        noLink: true,
      });
      return response === 0;
    } catch (err) {
      console.warn("Roary: Codex Pet replace confirmation failed:", err && err.message);
      return false;
    }
  }

  function getRemovalDialogStrings() {
    const all = {
      en: {
        uninstall: "Uninstall",
        cancel: "Cancel",
        message: (name) => `Uninstall imported pet "${name}"?`,
        detail: "Clawd will remove the source package from your Codex pets folder and clean up the generated theme. This cannot be undone.",
      },
      ru: {
        uninstall: "Удалить",
        cancel: "Отмена",
        message: (name) => `Удалить импортированного питомца "${name}"?`,
        detail: "Clawd удалит исходный пакет из вашей папки Codex pets и очистит сгенерированную тему. Это действие нельзя отменить.",
      },
      uk: {
        uninstall: "Видалити",
        cancel: "Скасувати",
        message: (name) => `Видалити імпортованого улюбленця "${name}"?`,
        detail: "Clawd видалить вихідний пакет із вашої папки Codex pets і очистить згенеровану тему. Цю дію не можна скасувати.",
      },
    };
    return all[getLang()] || all.en;
  }

  async function confirmRemoveImportedPackage(displayName) {
    const s = getRemovalDialogStrings();
    try {
      const { response } = await dialog.showMessageBox(getDialogParent(), {
        type: "warning",
        buttons: [s.uninstall, s.cancel],
        defaultId: 1,
        cancelId: 1,
        message: s.message(displayName || "Codex Pet"),
        detail: s.detail,
        noLink: true,
      });
      return response === 0;
    } catch (err) {
      console.warn("Roary: Codex Pet removal confirmation failed:", err && err.message);
      return false;
    }
  }

  async function materializeAndActivateImportedPet(imported) {
    const activeId = getActiveThemeId();
    const summary = syncThemes(activeId);
    if (summary.error) throw new Error(summary.error);
    const generated = (summary.themes || []).find((theme) => sameFsPath(theme.packageDir, imported.packageDir, path));
    if (!generated || !generated.themeId) {
      throw new Error("imported package did not materialize into a Clawd theme");
    }
    const result = await settingsController.applyCommand("setThemeSelection", { themeId: generated.themeId });
    if (!result || result.status !== "ok") {
      throw new Error((result && result.message) || "failed to switch to imported theme");
    }
    reloadActiveThemeIfUpdated(summary, activeId);
    rebuildMenusBestEffort({ logFailure: false });
    return { themeId: generated.themeId, summary };
  }

  async function handleImportProtocolUrl(rawUrl) {
    let parsed;
    try {
      parsed = codexPetImporter.parseClawdImportUrl(rawUrl);
    } catch (err) {
      await showImportError(err && err.message);
      return;
    }

    const s = getImportDialogStrings();
    const parent = getDialogParent();
    try {
      const { response } = await dialog.showMessageBox(parent, {
        type: "question",
        buttons: [s.import, s.cancel],
        defaultId: 1,
        cancelId: 1,
        message: s.confirmMessage(parsed.asciiHostname),
        detail: s.confirmDetail(parsed.url),
        noLink: true,
      });
      if (response !== 0) return;
    } catch (err) {
      console.warn("Roary: Codex Pet import confirmation failed:", err && err.message);
      return;
    }

    try {
      const imported = await codexPetImporter.importCodexPetFromUrl(parsed.url, {
        confirmReplaceExistingPackage: confirmReplaceExistingPackage,
      });
      await materializeAndActivateImportedPet(imported);
      await dialog.showMessageBox(parent, {
        type: "info",
        buttons: [s.ok],
        message: s.successMessage(imported.packageInfo.displayName || imported.packageInfo.id),
        detail: s.successDetail,
        noLink: true,
      });
    } catch (err) {
      if (err && err.code === codexPetImporter.ERR_REPLACE_DECLINED) return;
      console.warn("Roary: Codex Pet import failed:", err && err.message);
      await showImportError(err && err.message);
    }
  }

  async function openCodexPetsDir() {
    try {
      const dir = codexPetImporter.getDefaultCodexPetsDir();
      fs.mkdirSync(dir, { recursive: true });
      const message = await shell.openPath(dir);
      if (message) return { status: "error", message };
      return { status: "ok", path: dir };
    } catch (err) {
      console.warn("Roary: settings:open-codex-pets-dir failed:", err && err.message);
      return { status: "error", message: (err && err.message) || String(err) };
    }
  }

  async function importCodexPetZip(event) {
    const fromWebContents = BrowserWindow
      && typeof BrowserWindow.fromWebContents === "function"
      && event
      && event.sender
      ? BrowserWindow.fromWebContents(event.sender)
      : null;
    const parent = fromWebContents || getDialogParent();
    let picked;
    try {
      picked = await dialog.showOpenDialog(parent, {
        properties: ["openFile"],
        filters: [
          { name: "Codex Pet zip", extensions: ["zip"] },
        ],
      });
    } catch (err) {
      console.warn("Roary: Codex Pet zip picker failed:", err && err.message);
      return { status: "error", message: (err && err.message) || String(err) };
    }
    if (!picked || picked.canceled || !Array.isArray(picked.filePaths) || !picked.filePaths[0]) {
      return { status: "cancel" };
    }

    try {
      const zipPath = picked.filePaths[0];
      const stat = await fs.promises.stat(zipPath);
      if (stat.size > codexPetImporter.MAX_ZIP_BYTES) {
        throw new Error(`zip package exceeds ${codexPetImporter.MAX_ZIP_BYTES} bytes`);
      }
      const imported = await codexPetImporter.importCodexPetFromZipBuffer(await fs.promises.readFile(zipPath), {
        confirmReplaceExistingPackage: confirmReplaceExistingPackage,
      });
      const activated = await materializeAndActivateImportedPet(imported);
      return {
        status: "ok",
        themeId: activated.themeId,
        summary: activated.summary,
        imported: {
          id: imported.packageInfo.id,
          displayName: imported.packageInfo.displayName,
        },
      };
    } catch (err) {
      if (err && err.code === codexPetImporter.ERR_REPLACE_DECLINED) return { status: "cancel" };
      console.warn("Roary: Codex Pet zip import failed:", err && err.message);
      return { status: "error", message: (err && err.message) || String(err) };
    }
  }

  async function removeCodexPet(themeId) {
    if (typeof themeId !== "string" || !themeId) return { status: "error", message: "themeId is required" };
    const target = resolveRemovalTarget(themeId);
    if (!target || target.status !== "ok") {
      return { status: "error", message: (target && target.message) || "could not resolve imported pet" };
    }

    const meta = themeLoader.getThemeMetadata(themeId) || {};
    const displayName = typeof meta.name === "string" && meta.name
      ? meta.name
      : (target.marker.sourcePetId || themeId);

    try {
      if (target.exists) {
        const stat = await fs.promises.lstat(target.packageDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("managed Codex Pet source is not a plain directory");
        }
        try {
          await fs.promises.access(path.join(target.packageDir, "pet.json"), fs.constants.F_OK);
        } catch {
          throw new Error("managed Codex Pet source no longer contains pet.json; refresh imported pets instead");
        }
        const confirmed = await confirmRemoveImportedPackage(displayName);
        if (!confirmed) return { status: "cancel" };
        await fs.promises.rm(target.packageDir, { recursive: true, force: true });
      }

      const refresh = await refreshFromSettings();
      if (!refresh || refresh.status !== "ok") {
        return {
          status: "error",
          message: (refresh && refresh.message) || "removed package but failed to refresh imported pets",
          summary: refresh && refresh.summary,
        };
      }
      return {
        status: "ok",
        removed: {
          id: target.marker.sourcePetId || "",
          displayName,
        },
        summary: refresh.summary,
        switchedToFallback: !!refresh.switchedToFallback,
      };
    } catch (err) {
      console.warn("Roary: Codex Pet removal failed:", err && err.message);
      return { status: "error", message: (err && err.message) || String(err) };
    }
  }

  return {
    REGISTER_PROTOCOL_DEV_ARG,
    CLAWD_PROTOCOL_SCHEME,
    decorateThemeMetadata,
    enqueueImportUrl,
    enqueueImportUrlsFromArgv,
    extractClawdProtocolUrls,
    flushPendingImportUrls,
    getLastSyncSummary: () => lastSyncSummary,
    importCodexPetZip,
    isManagedTheme: (themeId) => !!readManagedThemeMarker(themeId),
    mergeSyncSummaries: mergeCodexPetSyncSummaries,
    openCodexPetsDir,
    readManagedThemeMarker,
    refreshFromSettings,
    registerProtocolClient,
    removeCodexPet,
    resolveRemovalTarget,
    setLastSyncSummary,
    summaryHasActiveOrphan: summaryHasActiveCodexPetOrphan,
    syncThemes,
  };
}

module.exports = createCodexPetMain;
module.exports.REGISTER_PROTOCOL_DEV_ARG = REGISTER_PROTOCOL_DEV_ARG;
module.exports.CLAWD_PROTOCOL_SCHEME = CLAWD_PROTOCOL_SCHEME;
module.exports.__test = {
  emptyCodexPetSyncSummary,
  extractClawdProtocolUrls,
  isFsPathInsideDir,
  mergeCodexPetSyncSummaries,
  sameFsPath,
  summaryHasActiveCodexPetOrphan,
};
