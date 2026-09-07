(() => {
  const register = globalThis.__registerCodexDynamicSkinModule;
  if (typeof register !== "function") throw new Error("Dynamic skin registry is unavailable.");

  register("controls", ({ document, window }) => ({
    create({ config, modules, ledger }) {
      const audioBus = modules.get("audio-bus");
      const storageKey = "codex.dynamicSkin.settings.v1";
      const normalizeStoredSettings = (raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const selected = {};
        for (const key of ["backgroundPlayback", "soundEnabled", "ambientMuted", "uiMuted"]) {
          if (typeof raw[key] === "boolean") selected[key] = raw[key];
        }
        for (const key of ["masterVolume", "ambientVolume", "uiVolume", "visualOpacity"]) {
          if (Number.isFinite(raw[key]) && raw[key] >= 0 && raw[key] <= 1) selected[key] = raw[key];
        }
        if (["pause", "continue"].includes(raw.hiddenAudio)) selected.hiddenAudio = raw.hiddenAudio;
        if (["auto", "full", "balanced", "media", "static"].includes(raw.quality)) selected.quality = raw.quality;
        if (["system", "on", "off"].includes(raw.reducedMotion)) selected.reducedMotion = raw.reducedMotion;
        return selected;
      };
      let persisted = {};
      try { persisted = normalizeStoredSettings(JSON.parse(window.localStorage?.getItem(storageKey) ?? "null")); } catch {}
      const sharedSettings = config.settingsAuthority === "shared-file";
      let settings = sharedSettings ? { ...config.settings } : { ...config.settings, ...persisted };
      if (sharedSettings) {
        try { window.localStorage?.setItem(storageKey, JSON.stringify(settings)); } catch {}
      }
      let draft = { ...settings };
      let selectedThemeId = config.theme.id;
      let destroyed = false;
      const centerOpenKey = "__CODEX_DYNAMIC_SKIN_THEME_CENTER_OPEN__";
      const injectedMenuItems = new Set();
      const restoredSuggestions = new Set();
      const zh = String(document.documentElement?.lang ?? "").toLowerCase().startsWith("zh");
      const text = zh ? {
        title: "主题中心", subtitle: "集中管理主题、媒体、声音与性能，保存后立即生效", library: "主题库", libraryHint: "选择后保存即可热切换，无需重启 Codex",
        theme: "主题", themeCount: (count) => `${count} 个主题`, current: "当前", playback: "播放与声音",
        searchThemes: "搜索主题", noThemeMatch: "没有匹配的主题", playbackStatus: "视频循环播放",
        playbackHint: "后台播放默认关闭；开启后需重启 Codex，且会增加资源占用", display: "显示与性能",
        displayHint: "根据设备性能调整画质和动效", enabled: "开启声音", backgroundPlayback: "后台播放", backgroundAudio: "切到后台时继续声音", master: "总音量",
        ambient: "环境音量", ui: "提示音量", opacity: "透明度", quality: "播放质量",
        motion: "动效", importMedia: "添加主题", deleteTheme: "删除选中主题",
        storage: "存储位置", storageHint: "主题视频、图片和缩略图可迁移到外置硬盘",
        changeStorage: "更改位置", repairStorage: "修复位置", storageUnavailable: "素材库不可用，请连接磁盘或修复位置",
        importHint: "支持 JPG、PNG、WebP、MP4 和 WebM；导入后自动加入主题库并立即应用",
        importing: "正在选择并导入媒体…", video: "视频", image: "图片", effect: "动态特效",
        withAudio: "含声音", silent: "静音",
        saved: "所有更改已保存", unsaved: "有未保存的更改", onlyTheme: "至少保留一个主题",
        deleteTitle: "确定删除选中的主题？", deleteHint: "删除后无法在主题库中选择；媒体源文件不会被修改。",
        restoreDefault: "还原默认主题", restoreDefaultHint: "关闭所有皮肤媒体、声音和视觉覆盖，恢复原生 Codex",
        keep: "保留主题", confirmDelete: "确认删除", cancel: "取消", save: "保存并应用",
      } : {
        title: "Theme center", subtitle: "Manage themes, media, sound, and performance in one place", library: "Theme library", libraryHint: "Save to hot-switch without restarting Codex",
        theme: "Theme", themeCount: (count) => `${count} themes`, current: "Current", playback: "Playback & sound",
        searchThemes: "Search themes", noThemeMatch: "No matching themes", playbackStatus: "Video loops continuously",
        playbackHint: "Background playback is off by default; enabling it requires a Codex restart and uses more resources", display: "Display & performance",
        displayHint: "Tune quality and motion for this device", enabled: "Enable sound", backgroundPlayback: "Background playback", backgroundAudio: "Keep audio playing in background", master: "Master volume",
        ambient: "Ambient volume", ui: "UI volume", opacity: "Opacity", quality: "Playback quality",
        motion: "Motion", importMedia: "Add theme", deleteTheme: "Delete selected theme",
        storage: "Storage location", storageHint: "Move theme videos, images, and thumbnails to an external drive",
        changeStorage: "Change location", repairStorage: "Repair location", storageUnavailable: "Library unavailable. Connect the drive or repair its location.",
        importHint: "Supports JPG, PNG, WebP, MP4, and WebM; imports are added to the library and applied immediately",
        importing: "Selecting and importing media…", video: "Video", image: "Image", effect: "Effect",
        withAudio: "Audio", silent: "Silent",
        saved: "All changes saved", unsaved: "Unsaved changes", onlyTheme: "Keep at least one theme installed",
        deleteTitle: "Delete the selected theme?", deleteHint: "It will no longer appear in the library. The source media file is not changed.",
        restoreDefault: "Restore default theme", restoreDefaultHint: "Remove all skin media, sound, and visual overrides and return to native Codex",
        keep: "Keep theme", confirmDelete: "Delete", cancel: "Cancel", save: "Save & apply",
      };

      const host = document.createElement("div");
      host.setAttribute("data-dynamic-skin-controls", "");
      Object.assign(host.style, {
        position: "fixed", inset: "0", zIndex: "2147483000", display: "none",
        alignItems: "center", justifyContent: "center", padding: "18px",
        background: "rgba(5,7,12,.46)", backdropFilter: "blur(5px)",
      });
      const responsiveStyle = document.createElement("style");
      responsiveStyle.textContent = `
        [data-dynamic-skin-controls] button,
        [data-dynamic-skin-controls] select,
        [data-dynamic-skin-controls] input { transition: border-color 160ms ease, background-color 160ms ease, opacity 160ms ease; }
        [data-dynamic-skin-controls] button:focus-visible,
        [data-dynamic-skin-controls] select:focus-visible,
        [data-dynamic-skin-controls] input:focus-visible { outline: 2px solid rgba(98,185,255,.95); outline-offset: 2px; }
        [data-dynamic-skin-controls] button:hover:not(:disabled) { border-color: rgba(255,255,255,.24) !important; }
        [data-dynamic-skin-controls] button:disabled,
        [data-dynamic-skin-controls] input:disabled { cursor: not-allowed !important; opacity: .5; }
        @media (max-width: 760px) {
          [data-theme-center-workspace] { grid-template-columns: 1fr !important; }
          [data-theme-library-column] { max-height: none !important; }
        }
        @media (max-width: 560px) {
          [data-dynamic-skin-center-panel] { padding: 17px !important; }
          [data-skin-setting-row] { grid-template-columns: 1fr !important; gap: 7px !important; padding: 9px 0 !important; }
          [data-setting="themeId"] { grid-template-columns: 1fr !important; }
          [data-skin-section] > div:first-child { align-items: flex-start !important; flex-direction: column !important; gap: 4px !important; }
          [data-skin-action-row] { grid-template-columns: 1fr !important; }
          [data-delete-confirmation] { align-items: flex-start !important; flex-direction: column !important; }
          [data-skin-footer] { position: static !important; padding-bottom: 0 !important; background: none !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-dynamic-skin-controls] * { transition: none !important; }
        }
      `;
      host.append(responsiveStyle);
      const panel = document.createElement("div");
      panel.setAttribute("data-dynamic-skin-center-panel", "");
      panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-label", text.title);
      panel.setAttribute("tabindex", "-1");
      Object.assign(panel.style, {
        width: "min(940px, calc(100vw - 36px))", maxHeight: "min(880px, calc(100vh - 36px))",
        overflow: "auto", padding: "22px", borderRadius: "14px", boxSizing: "border-box",
        border: "1px solid rgba(255,255,255,.14)", background: "rgba(20,22,29,.96)",
        color: "white", boxShadow: "0 24px 72px rgba(0,0,0,.5)",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
      });
      const heading = document.createElement("strong");
      heading.textContent = text.title;
      Object.assign(heading.style, { display: "block", fontSize: "19px", letterSpacing: "-.01em",
        marginBottom: "4px" });
      panel.append(heading);
      const subtitle = document.createElement("div"); subtitle.textContent = text.subtitle;
      Object.assign(subtitle.style, { color: "rgba(255,255,255,.6)", fontSize: "13px", marginBottom: "18px" });
      panel.append(subtitle);
      const workspace = document.createElement("div");
      workspace.setAttribute("data-theme-center-workspace", "");
      Object.assign(workspace.style, { display: "grid", gridTemplateColumns: "minmax(240px,.82fr) minmax(360px,1.18fr)",
        gap: "20px", alignItems: "start" });
      const libraryColumn = document.createElement("div"); libraryColumn.setAttribute("data-theme-library-column", "");
      Object.assign(libraryColumn.style, { minWidth: "0", maxHeight: "650px", overflow: "auto",
        paddingRight: "2px" });
      const settingsColumn = document.createElement("div"); settingsColumn.setAttribute("data-theme-settings-column", "");
      Object.assign(settingsColumn.style, { minWidth: "0" });
      workspace.append(libraryColumn, settingsColumn); panel.append(workspace);
      const controls = new Map();
      const settingValues = new Map();
      const soundDependentControls = new Set();
      let currentSection = panel;
      let saveButton = null;
      let saveState = null;

      function markDirty() {
        if (saveButton) saveButton.disabled = false;
        if (saveState) {
          saveState.textContent = text.unsaved;
          saveState.setAttribute("data-state", "dirty");
          saveState.style.color = "rgba(255,202,117,.9)";
        }
      }
      function section(kind, title, hint) {
        const item = document.createElement("section"); item.setAttribute("data-skin-section", kind);
        Object.assign(item.style, { padding: "16px 0", borderTop: "1px solid rgba(255,255,255,.09)" });
        const header = document.createElement("div");
        Object.assign(header.style, { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", marginBottom: "10px" });
        const titleNode = document.createElement("strong"); titleNode.textContent = title;
        Object.assign(titleNode.style, { fontSize: "14px", fontWeight: "600" });
        header.append(titleNode);
        if (hint) {
          const hintNode = document.createElement("span"); hintNode.textContent = hint;
          Object.assign(hintNode.style, { color: "rgba(255,255,255,.52)", fontSize: "12px", textAlign: "right" });
          header.append(hintNode);
        }
        item.append(header);
        (kind === "library" ? libraryColumn : settingsColumn).append(item);
        currentSection = item; return item;
      }

      function row(labelText) {
        const label = document.createElement("label");
        label.setAttribute("data-skin-setting-row", "");
        Object.assign(label.style, { display: "grid", gridTemplateColumns: "minmax(108px, 1fr) minmax(180px, 1.35fr)",
          alignItems: "center", gap: "18px", minHeight: "46px", fontSize: "14px",
          borderTop: "1px solid rgba(255,255,255,.065)" });
        const caption = document.createElement("span"); caption.textContent = labelText;
        label.append(caption); currentSection.append(label); return label;
      }
      function addSelect(key, labelText, options, value, onDraft) {
        const label = row(labelText);
        const select = document.createElement("select");
        select.setAttribute("data-setting", key); select.setAttribute("aria-label", labelText);
        for (const optionValue of options) {
          const option = document.createElement("option");
          option.value = optionValue.value; option.textContent = optionValue.label; select.append(option);
        }
        select.value = value;
        Object.assign(select.style, { width: "100%", minHeight: "32px", color: "#f6f7fb",
          colorScheme: "dark", background: "#292c36", border: "1px solid rgba(255,255,255,.14)",
          borderRadius: "9px", padding: "4px 10px", outline: "none" });
        select.onchange = () => { if (onDraft) onDraft(select.value); else draft[key] = select.value; markDirty(); };
        controls.set(key, select); label.append(select); return select;
      }
      const catalog = Array.isArray(config.themeCatalog) ? config.themeCatalog : [];
      let themePicker = null;
      const themeButtons = new Map();
      function renderThemeSelection() {
        for (const [id, button] of themeButtons) {
          const active = id === selectedThemeId;
          button.setAttribute("aria-checked", String(active));
          Object.assign(button.style, {
            borderColor: active ? "rgba(111,190,255,.92)" : "rgba(255,255,255,.11)",
            background: active ? "rgba(75,157,226,.2)" : "rgba(255,255,255,.045)",
            boxShadow: active ? "0 0 0 1px rgba(91,180,255,.22) inset" : "none",
          });
        }
      }
      if (catalog.length) {
        const librarySection = section("library", text.library, text.libraryHint);
        const count = document.createElement("span"); count.textContent = text.themeCount(catalog.length);
        count.setAttribute("data-theme-count", "");
        Object.assign(count.style, { display: "block", color: "rgba(255,255,255,.52)", fontSize: "12px", marginBottom: "9px" });
        const search = document.createElement("input");
        search.type = "search"; search.setAttribute("data-theme-search", "");
        search.setAttribute("placeholder", text.searchThemes); search.setAttribute("aria-label", text.searchThemes);
        Object.assign(search.style, { width: "100%", minHeight: "38px", boxSizing: "border-box", marginBottom: "10px",
          padding: "0 11px", borderRadius: "10px", border: "1px solid rgba(255,255,255,.12)",
          color: "#f6f7fb", background: "rgba(255,255,255,.05)", outline: "none" });
        themePicker = document.createElement("div");
        themePicker.setAttribute("data-setting", "themeId"); themePicker.setAttribute("role", "radiogroup");
        themePicker.setAttribute("aria-label", text.theme);
        themePicker.setAttribute("tabindex", "0");
        Object.assign(themePicker.style, { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))",
          gap: "10px", maxHeight: "392px", overflowY: "auto", overscrollBehavior: "contain",
          scrollbarGutter: "stable", padding: "2px 6px 2px 2px" });
        for (const item of catalog) {
          const button = document.createElement("button");
          button.type = "button";
          button.setAttribute("data-theme-id", item.id); button.setAttribute("role", "radio");
          Object.assign(button.style, { minHeight: "152px", padding: "6px", borderRadius: "12px",
            border: "1px solid rgba(255,255,255,.11)", color: "#f6f7fb", textAlign: "left",
            fontSize: "13px", cursor: "pointer", position: "relative", display: "flex",
            flexDirection: "column", gap: "8px", overflow: "hidden" });
          const thumbnailFrame = document.createElement("span");
          thumbnailFrame.setAttribute("data-theme-thumbnail-frame", "");
          Object.assign(thumbnailFrame.style, { display: "block", width: "100%", aspectRatio: "16 / 9",
            overflow: "hidden", borderRadius: "8px", background: "linear-gradient(135deg,rgba(70,126,175,.32),rgba(64,41,90,.38))" });
          if (item.thumbnail) {
            const thumbnail = document.createElement("img");
            thumbnail.setAttribute("data-theme-thumbnail", item.id);
            thumbnail.alt = ""; thumbnail.src = item.thumbnail; thumbnail.loading = "lazy";
            thumbnail.decoding = "async"; thumbnail.draggable = false;
            Object.assign(thumbnail.style, { display: "block", width: "100%", height: "100%",
              aspectRatio: "16 / 9", objectFit: "cover" });
            thumbnail.onerror = () => { thumbnail.style.display = "none"; };
            thumbnailFrame.append(thumbnail);
          }
          const details = document.createElement("span");
          Object.assign(details.style, { display: "block", minWidth: "0", padding: "0 4px 3px" });
          const name = document.createElement("span"); name.textContent = item.name;
          Object.assign(name.style, { display: "block", fontWeight: "600", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap" });
          const kind = document.createElement("span"); kind.setAttribute("data-theme-kind", item.kind ?? "unknown");
          const kindLabel = item.kind === "video" ? text.video : item.kind === "image" ? text.image
            : item.kind === "builtin-effect" ? text.effect : text.theme;
          kind.textContent = `${kindLabel} · ${item.hasAudio ? text.withAudio : text.silent}`;
          Object.assign(kind.style, { display: "block", marginTop: "4px", color: "rgba(255,255,255,.5)", fontSize: "11px" });
          details.append(name, kind); button.append(thumbnailFrame, details);
          if (item.id === config.theme.id) {
            button.setAttribute("aria-label", `${item.name} · ${text.current}`);
            const badge = document.createElement("span");
            badge.textContent = zh ? "当前使用" : "In use";
            badge.setAttribute("data-theme-current-badge", "");
            Object.assign(badge.style, { display: "inline-block", marginLeft: "8px", padding: "2px 6px",
              borderRadius: "999px", color: "#9ed5ff", background: "rgba(88,169,235,.16)",
              fontSize: "10px", whiteSpace: "nowrap" });
            name.append(badge);
          }
          button.onclick = () => { selectedThemeId = item.id; renderThemeSelection(); markDirty(); };
          themeButtons.set(item.id, button); themePicker.append(button);
        }
        const empty = document.createElement("div"); empty.textContent = text.noThemeMatch;
        empty.setAttribute("data-theme-search-empty", "");
        Object.assign(empty.style, { display: "none", padding: "18px 10px", color: "rgba(255,255,255,.5)",
          fontSize: "13px", textAlign: "center" });
        search.oninput = () => {
          const query = String(search.value ?? "").trim().toLocaleLowerCase();
          let visible = 0;
          for (const item of catalog) {
            const button = themeButtons.get(item.id);
            const match = !query || item.name.toLocaleLowerCase().includes(query) || item.id.includes(query);
            button.style.display = match ? "flex" : "none";
            if (match) visible += 1;
          }
          empty.style.display = visible ? "none" : "block";
        };
        renderThemeSelection(); librarySection.append(count, search, themePicker, empty);
      }
      const storage = config.storage;
      const storageAvailable = storage?.available !== false;
      if (storage) {
        const storageSection = section("storage", text.storage, text.storageHint);
        const storageCard = document.createElement("div"); storageCard.setAttribute("data-theme-storage", "");
        Object.assign(storageCard.style, { padding: "11px", borderRadius: "10px", background: "rgba(255,255,255,.045)",
          border: `1px solid ${storageAvailable ? "rgba(255,255,255,.1)" : "rgba(255,132,105,.3)"}` });
        const storagePath = document.createElement("div"); storagePath.setAttribute("data-theme-storage-path", "");
        storagePath.textContent = storage.path;
        Object.assign(storagePath.style, { overflowWrap: "anywhere", fontSize: "12px", lineHeight: "1.45", color: "rgba(255,255,255,.82)" });
        const formatBytes = (bytes) => {
          if (bytes < 1024) return `${bytes} B`;
          const units = ["KB", "MB", "GB", "TB"]; let value = bytes / 1024; let unit = units[0];
          for (let index = 1; index < units.length && value >= 1024; index += 1) { value /= 1024; unit = units[index]; }
          return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
        };
        const storageMeta = document.createElement("div"); storageMeta.setAttribute("data-theme-storage-meta", "");
        storageMeta.textContent = storageAvailable
          ? `${storage.themeCount} ${zh ? "个主题" : "themes"} · ${formatBytes(storage.bytes)}`
          : text.storageUnavailable;
        Object.assign(storageMeta.style, { marginTop: "6px", color: storageAvailable ? "rgba(255,255,255,.5)" : "rgba(255,174,150,.9)",
          fontSize: "11px", lineHeight: "1.4" });
        const storageButton = document.createElement("button"); storageButton.type = "button";
        storageButton.textContent = storageAvailable ? text.changeStorage : text.repairStorage;
        storageButton.setAttribute("data-skin-action", "change-storage");
        Object.assign(storageButton.style, { width: "100%", minHeight: "36px", marginTop: "10px", borderRadius: "9px",
          border: "1px solid rgba(115,199,255,.34)", background: "rgba(49,138,200,.2)", color: "#eaf6ff", cursor: "pointer" });
        storageButton.onclick = () => dispatchAction("change-storage");
        storageCard.append(storagePath, storageMeta, storageButton); storageSection.append(storageCard);
      }
      section("playback", text.playback, text.playbackHint);
      const playbackStatus = document.createElement("div");
      playbackStatus.setAttribute("data-playback-status", "");
      const updatePlaybackStatus = (enabled) => {
        const support = config.backgroundPlaybackSupport ?? "restart-required";
        playbackStatus.setAttribute("data-support", support);
        playbackStatus.textContent = support === "restart-required" && enabled
          ? `${text.playbackStatus} · ${zh ? "已保存；下次由 Dream Skin 启动 Codex 后生效" : "Saved; takes effect next time Codex is launched by Dream Skin"}`
          : `${text.playbackStatus} · ${enabled
          ? (zh ? "后台播放已开启" : "Background playback on")
          : (zh ? "切出应用时暂停" : "Pauses outside the app")}`;
      };
      updatePlaybackStatus(settings.backgroundPlayback === true);
      Object.assign(playbackStatus.style, { margin: "0 0 8px", padding: "9px 11px", borderRadius: "9px",
        background: "rgba(72,155,218,.1)", border: "1px solid rgba(105,183,239,.18)",
        color: "rgba(195,229,255,.88)", fontSize: "12px" });
      currentSection.append(playbackStatus);
      const enabledLabel = row(text.enabled);
      const enabled = document.createElement("input");
      enabled.type = "checkbox"; enabled.checked = settings.soundEnabled;
      enabled.style.accentColor = "#62b9ff";
      enabled.setAttribute("data-setting", "soundEnabled"); enabled.setAttribute("aria-label", text.enabled);
      function syncSoundControls() {
        for (const input of soundDependentControls) {
          input.disabled = !enabled.checked;
          input.setAttribute("aria-disabled", String(input.disabled));
          if (input.parentNode?.style) input.parentNode.style.opacity = input.disabled ? ".48" : "1";
        }
      }
      enabled.onchange = () => { draft.soundEnabled = Boolean(enabled.checked); syncSoundControls(); markDirty(); };
      controls.set("soundEnabled", enabled); enabledLabel.append(enabled);
      const backgroundPlaybackLabel = row(text.backgroundPlayback);
      const backgroundPlayback = document.createElement("input");
      backgroundPlayback.type = "checkbox";
      backgroundPlayback.checked = settings.backgroundPlayback === true;
      backgroundPlayback.style.accentColor = "#62b9ff";
      backgroundPlayback.setAttribute("data-setting", "backgroundPlayback");
      backgroundPlayback.setAttribute("aria-label", text.backgroundPlayback);
      backgroundPlayback.onchange = () => {
        draft.backgroundPlayback = Boolean(backgroundPlayback.checked);
        updatePlaybackStatus(draft.backgroundPlayback); markDirty();
      };
      controls.set("backgroundPlayback", backgroundPlayback);
      backgroundPlaybackLabel.append(backgroundPlayback);
      const backgroundAudioLabel = row(text.backgroundAudio);
      const backgroundAudio = document.createElement("input");
      backgroundAudio.type = "checkbox";
      backgroundAudio.checked = settings.hiddenAudio === "continue";
      backgroundAudio.style.accentColor = "#62b9ff";
      backgroundAudio.setAttribute("data-setting", "hiddenAudio");
      backgroundAudio.setAttribute("aria-label", text.backgroundAudio);
      backgroundAudio.onchange = () => {
        draft.hiddenAudio = backgroundAudio.checked ? "continue" : "pause";
        markDirty();
      };
      controls.set("hiddenAudio", backgroundAudio);
      soundDependentControls.add(backgroundAudio);
      backgroundAudioLabel.append(backgroundAudio);
      function addSlider(key, labelText, { soundDependent = false } = {}) {
        const label = row(labelText);
        const valueWrap = document.createElement("div");
        Object.assign(valueWrap.style, { display: "grid", gridTemplateColumns: "1fr 44px", alignItems: "center", gap: "10px" });
        const input = document.createElement("input");
        input.type = "range"; input.min = "0"; input.max = "1"; input.step = "0.05";
        input.value = String(settings[key]); input.setAttribute("data-setting", key);
        input.setAttribute("aria-label", labelText);
        Object.assign(input.style, { width: "100%", accentColor: "#62b9ff" });
        const value = document.createElement("output"); value.setAttribute("data-setting-value", key);
        value.textContent = `${Math.round(Number(input.value) * 100)}%`;
        Object.assign(value.style, { color: "rgba(255,255,255,.64)", fontSize: "12px", textAlign: "right", fontVariantNumeric: "tabular-nums" });
        input.oninput = () => {
          draft[key] = Math.min(1, Math.max(0, Number(input.value)));
          value.textContent = `${Math.round(draft[key] * 100)}%`;
          if (key === "visualOpacity") {
            modules.get("media-layer")?.setOpacity?.(draft[key]);
          }
          markDirty();
        };
        controls.set(key, input); settingValues.set(key, value);
        if (soundDependent) soundDependentControls.add(input);
        valueWrap.append(input, value); label.append(valueWrap);
      }
      addSlider("masterVolume", text.master, { soundDependent: true });
      if (config.theme.audio.ambient.source !== "none") addSlider("ambientVolume", text.ambient, { soundDependent: true });
      if (Object.keys(config.theme.audio.ui.events).length) addSlider("uiVolume", text.ui, { soundDependent: true });
      syncSoundControls();
      section("display", text.display, text.displayHint);
      addSlider("visualOpacity", text.opacity);
      addSelect("quality", text.quality, [
        { value: "auto", label: zh ? "自动" : "Auto" }, { value: "full", label: zh ? "最高" : "Full" },
        { value: "balanced", label: zh ? "均衡" : "Balanced" }, { value: "media", label: zh ? "仅媒体" : "Media" },
        { value: "static", label: zh ? "静态" : "Static" },
      ], settings.quality);
      addSelect("reducedMotion", text.motion, [
        { value: "system", label: zh ? "跟随系统" : "System" }, { value: "off", label: zh ? "开启" : "On" },
        { value: "on", label: zh ? "关闭" : "Off" },
      ], settings.reducedMotion);
      const actionRow = document.createElement("div");
      actionRow.setAttribute("data-skin-action-row", "");
      Object.assign(actionRow.style, { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "12px" });
      function dispatchAction(action, detail = {}) {
        const sequence = (Number(window.__CODEX_DYNAMIC_SKIN_ACTION_SEQUENCE__) || 0) + 1;
        window.__CODEX_DYNAMIC_SKIN_ACTION_SEQUENCE__ = sequence;
        const request = { action, themeId: config.theme.id, generation: config.generation, issuedAt: Date.now(), sequence, ...detail };
        window.__CODEX_DYNAMIC_SKIN_ACTION_REQUEST__ = request;
        window.dispatchEvent(new window.CustomEvent("codex-dynamic-skin-action-request", { detail: request }));
      }
      function actionButton(action, label) {
        const item = document.createElement("button");
        item.type = "button"; item.textContent = label; item.setAttribute("data-skin-action", action);
        Object.assign(item.style, { minHeight: "38px", borderRadius: "10px",
          border: "1px solid rgba(255,255,255,.11)", background: "rgba(255,255,255,.055)",
          color: "#f5f6fa", cursor: "pointer" });
        item.onclick = () => dispatchAction(action);
        actionRow.append(item);
        return item;
      }
      const importButton = actionButton("import-media", text.importMedia);
      importButton.style.background = "rgba(49,138,200,.3)";
      importButton.style.borderColor = "rgba(115,199,255,.42)";
      const deleteButton = actionButton("delete-theme", text.deleteTheme); libraryColumn.append(actionRow);
      const restoreDefault = actionButton("restore-default-theme", text.restoreDefault);
      restoreDefault.setAttribute("title", text.restoreDefaultHint);
      restoreDefault.style.marginTop = "10px";
      restoreDefault.style.width = "100%";
      restoreDefault.style.borderColor = "rgba(255,255,255,.18)";
      libraryColumn.append(restoreDefault);
      const importHint = document.createElement("div");
      importHint.textContent = text.importHint; importHint.setAttribute("data-theme-import-hint", "");
      Object.assign(importHint.style, { marginTop: "8px", color: "rgba(255,255,255,.5)", fontSize: "12px", lineHeight: "1.45" });
      libraryColumn.append(importHint);
      const importStatus = document.createElement("div");
      importStatus.setAttribute("data-theme-import-status", "");
      Object.assign(importStatus.style, { display: "none", marginTop: "8px", padding: "9px 10px",
        borderRadius: "9px", fontSize: "12px", lineHeight: "1.4", background: "rgba(72,155,218,.1)",
        border: "1px solid rgba(105,183,239,.18)", color: "rgba(195,229,255,.9)" });
      libraryColumn.append(importStatus);
      const setImportStatus = (status) => {
        const active = status && typeof status === "object";
        importStatus.style.display = active ? "block" : "none";
        importStatus.textContent = active ? String(status.message || text.importing) : "";
        importStatus.setAttribute("data-state", active ? String(status.state || "loading") : "idle");
        importButton.disabled = !storageAvailable || (active && status.state === "loading");
      };
      setImportStatus(window.__CODEX_DYNAMIC_SKIN_LIBRARY_ACTION_STATUS__);
      importButton.onclick = () => {
        const pending = { state: "loading", message: text.importing, issuedAt: Date.now() };
        window.__CODEX_DYNAMIC_SKIN_LIBRARY_ACTION_STATUS__ = pending;
        setImportStatus(pending);
        dispatchAction("import-media");
      };
      const onLibraryStatus = (event) => setImportStatus(event?.detail);
      window.addEventListener?.("codex-dynamic-skin-library-status", onLibraryStatus);
      ledger?.track?.("listener", () => window.removeEventListener?.("codex-dynamic-skin-library-status", onLibraryStatus));
      const deleteConfirmation = document.createElement("div"); deleteConfirmation.setAttribute("data-delete-confirmation", "");
      Object.assign(deleteConfirmation.style, { display: "none", alignItems: "center", justifyContent: "space-between", gap: "14px",
        marginTop: "10px", padding: "12px", borderRadius: "10px", background: "rgba(211,72,72,.12)", border: "1px solid rgba(255,120,120,.24)" });
      const deleteCopy = document.createElement("div");
      const deleteTitle = document.createElement("strong"); deleteTitle.textContent = text.deleteTitle;
      const deleteHint = document.createElement("div"); deleteHint.textContent = text.deleteHint;
      Object.assign(deleteHint.style, { marginTop: "3px", color: "rgba(255,255,255,.58)", fontSize: "12px" });
      deleteCopy.append(deleteTitle, deleteHint);
      const deleteActions = document.createElement("div"); Object.assign(deleteActions.style, { display: "flex", gap: "8px", flexShrink: "0" });
      const keep = document.createElement("button"); keep.type = "button"; keep.textContent = text.keep;
      keep.setAttribute("data-skin-action", "cancel-delete-theme");
      const confirmDelete = document.createElement("button"); confirmDelete.type = "button"; confirmDelete.textContent = text.confirmDelete;
      confirmDelete.setAttribute("data-skin-action", "confirm-delete-theme");
      for (const item of [keep, confirmDelete]) Object.assign(item.style, { minHeight: "34px", padding: "0 11px", borderRadius: "8px",
        border: "1px solid rgba(255,255,255,.12)", color: "white", background: "rgba(255,255,255,.06)", cursor: "pointer" });
      confirmDelete.style.background = "#b54848";
      deleteActions.append(keep, confirmDelete); deleteConfirmation.append(deleteCopy, deleteActions); settingsColumn.append(deleteConfirmation);
      const canDeleteTheme = storageAvailable && catalog.length > 1;
      deleteButton.disabled = !canDeleteTheme;
      if (!canDeleteTheme) deleteButton.setAttribute("title", text.onlyTheme);
      deleteButton.onclick = () => { if (canDeleteTheme) deleteConfirmation.style.display = "flex"; };
      keep.onclick = () => { deleteConfirmation.style.display = "none"; };
      confirmDelete.onclick = () => dispatchAction("delete-theme", { targetThemeId: selectedThemeId });
      const footer = document.createElement("div");
      footer.setAttribute("data-skin-footer", "");
      Object.assign(footer.style, { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "10px", marginTop: "18px",
        position: "sticky", bottom: "-22px", zIndex: "1", padding: "12px 0 22px",
        background: "linear-gradient(180deg, rgba(20,22,29,0), rgba(20,22,29,.98) 24%)" });
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = text.cancel;
      cancel.setAttribute("data-skin-action", "cancel");
      const save = document.createElement("button"); save.type = "button"; save.textContent = text.save;
      Object.assign(cancel.style, { minHeight: "38px", padding: "0 15px", border: "0", borderRadius: "10px",
        background: "transparent", color: "rgba(255,255,255,.72)", cursor: "pointer" });
      Object.assign(save.style, { minHeight: "38px", padding: "0 16px", border: "1px solid rgba(115,199,255,.55)",
        borderRadius: "10px", background: "#318ac8", color: "white", fontWeight: "600", cursor: "pointer" });
      saveState = document.createElement("span"); saveState.textContent = text.saved;
      saveState.setAttribute("data-skin-save-state", ""); saveState.setAttribute("data-state", "saved");
      Object.assign(saveState.style, { marginRight: "auto", color: "rgba(255,255,255,.46)", fontSize: "12px" });
      save.setAttribute("data-skin-action", "save"); footer.append(saveState, cancel, save); panel.append(footer);
      saveButton = save; save.disabled = true;
      host.append(panel); document.body.append(host);

      function resetDraft() {
        draft = { ...settings }; selectedThemeId = config.theme.id;
        for (const [key, input] of controls) {
          if (input.type === "checkbox") input.checked = key === "hiddenAudio"
            ? draft.hiddenAudio === "continue" : Boolean(draft[key]);
          else {
            input.value = String(draft[key]);
            if (settingValues.has(key)) settingValues.get(key).textContent = `${Math.round(Number(draft[key]) * 100)}%`;
          }
        }
        renderThemeSelection(); syncSoundControls(); updatePlaybackStatus(draft.backgroundPlayback === true);
        deleteConfirmation.style.display = "none"; save.disabled = true;
        saveState.textContent = text.saved; saveState.setAttribute("data-state", "saved");
        saveState.style.color = "rgba(255,255,255,.46)";
      }
      function closePanel({ restorePreview = true } = {}) {
        if (restorePreview) modules.get("media-layer")?.setOpacity?.(settings.visualOpacity ?? 1);
        window[centerOpenKey] = false;
        host.style.display = "none";
      }
      function openPanel() { window[centerOpenKey] = true; resetDraft(); host.style.display = "flex"; panel.focus?.(); }
      function publish(next) {
        settings = { ...next };
        audioBus?.setSettings?.(settings);
        const mediaLayer = modules.get("media-layer");
        mediaLayer?.setOpacity?.(settings.visualOpacity ?? 1);
        mediaLayer?.setReducedMotion?.(settings.reducedMotion);
        mediaLayer?.setBackgroundPlayback?.(settings.backgroundPlayback === true);
        modules.get("performance-policy")?.setPreference?.(settings.quality, settings.reducedMotion);
        try { window.localStorage?.setItem(storageKey, JSON.stringify(settings)); } catch {}
        window.dispatchEvent(new window.CustomEvent("codex-dynamic-skin-settings-change", {
          detail: JSON.parse(JSON.stringify(settings)),
        }));
      }
      audioBus?.setSettings?.(settings);
      modules.get("media-layer")?.setOpacity?.(settings.visualOpacity ?? 1);
      modules.get("media-layer")?.setReducedMotion?.(settings.reducedMotion);
      modules.get("media-layer")?.setBackgroundPlayback?.(settings.backgroundPlayback === true);
      modules.get("performance-policy")?.setPreference?.(settings.quality, settings.reducedMotion);
      cancel.onclick = closePanel;
      save.onclick = async (event) => {
        if (draft.soundEnabled && event?.isTrusted) {
          try { await audioBus?.unlockFromGesture?.(event); } catch { return false; }
        }
        publish(draft);
        dispatchAction("save-settings", { settings: { ...settings, schemaVersion: 1 } });
        if ((config.displayMode === "native" || selectedThemeId !== config.theme.id)
          && catalog.some((item) => item.id === selectedThemeId)) {
          const sequence = (Number(window.__CODEX_DYNAMIC_SKIN_REQUEST_SEQUENCE__) || 0) + 1;
          window.__CODEX_DYNAMIC_SKIN_REQUEST_SEQUENCE__ = sequence;
          window.__CODEX_DYNAMIC_SKIN_THEME_REQUEST__ = {
            id: selectedThemeId,
            fromThemeId: config.theme.id,
            generation: config.generation,
            issuedAt: Date.now(),
            sequence,
          };
          window.dispatchEvent(new window.CustomEvent("codex-dynamic-skin-theme-request", { detail: { id: selectedThemeId } }));
        }
        closePanel({ restorePreview: false });
        return true;
      };
      panel.onkeydown = (event) => { if (event.key === "Escape") { event.preventDefault(); closePanel(); } };
      host.onclick = (event) => { if (event.target === host) closePanel(); };
      // A replacement generation is constructed while the previous one is
      // still active. Keep its panel concealed until the controller's atomic
      // handoff so two live settings centers can never overlap.

      function insertMenuItem() {
        const menus = [...(document.querySelectorAll?.('[role="menu"]') ?? [])];
        for (const menu of menus) {
          if (menu.querySelector?.('[data-dynamic-skin-menu-item]')) continue;
          const items = [...(menu.querySelectorAll?.('[role="menuitem"]') ?? [])];
          const settingsItem = items.find((item) => /^(设置|Settings)/i.test(item.textContent?.trim() ?? ""));
          if (!settingsItem?.parentElement) continue;
          const item = document.createElement("div");
          item.setAttribute("role", "menuitem"); item.setAttribute("tabindex", "-1");
          item.setAttribute("data-dynamic-skin-menu-item", ""); item.className = settingsItem.className;
          const content = document.createElement("div");
          content.className = settingsItem.firstElementChild?.className ?? "flex w-full items-center gap-1.5";
          const icon = document.createElement("span"); icon.textContent = "✦";
          icon.setAttribute("aria-hidden", "true"); icon.className = "icon-xs shrink-0 opacity-75";
          const label = document.createElement("span"); label.textContent = text.title; label.className = "flex-1 min-w-0 truncate";
          content.append(icon, label); item.append(content);
          item.onclick = (event) => { event.preventDefault?.(); event.stopPropagation?.(); openPanel(); };
          settingsItem.parentElement.insertBefore(item, settingsItem); injectedMenuItems.add(item);
        }
      }

      function restoreNativeSuggestions() {
        const grids = [...(document.querySelectorAll?.("div.grid") ?? [])]
          .filter((grid) => String(grid.className ?? "").includes("grid-cols-[repeat(auto-fit"));
        for (const grid of grids) {
          if (grid.children.length >= 4 || !grid.lastElementChild?.cloneNode) continue;
          const fiberKey = Object.keys(grid).find((key) => key.startsWith("__reactFiber"));
          let fiber = fiberKey ? grid[fiberKey] : null;
          let items = null;
          for (let depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
            const candidate = fiber.memoizedProps?.items;
            if (Array.isArray(candidate) && candidate.length >= 4
              && candidate.every((item) => typeof item?.label === "string"
                && typeof item?.onClick === "function")) {
              items = candidate;
              break;
            }
          }
          if (!items) continue;
          const visibleLabels = new Set([...grid.children].map((child) => child.textContent?.trim() ?? ""));
          for (const [index, item] of items.entries()) {
            if (grid.children.length >= 4 || visibleLabels.has(item.label)) continue;
            const clone = grid.lastElementChild.cloneNode(true);
            clone.setAttribute("data-dynamic-skin-restored-suggestion", item.id ?? String(index));
            const button = clone.querySelector?.("button");
            const label = clone.querySelector?.('[id$="-label"]')
              ?? button?.querySelector?.("span:last-child span");
            if (!button || !label) continue;
            const labelId = `dynamic-skin-suggestion-${index}`;
            label.id = labelId;
            label.textContent = item.label;
            button.setAttribute("aria-labelledby", labelId);
            button.onclick = (event) => {
              event.preventDefault?.();
              event.stopPropagation?.();
              item.onClick();
            };
            grid.append(clone);
            visibleLabels.add(item.label);
            restoredSuggestions.add(clone);
          }
        }
      }

      function syncOwnedUi() {
        insertMenuItem();
        restoreNativeSuggestions();
      }
      syncOwnedUi();
      const observer = typeof window.MutationObserver === "function"
        ? new window.MutationObserver(syncOwnedUi) : null;
      if (observer && document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
        ledger?.track?.("observer", () => observer.disconnect());
      }
      return {
        open: openPanel,
        reveal() { if (window[centerOpenKey] === true) openPanel(); return true; },
        conceal() { host.style.display = "none"; return true; },
        diagnostics: () => Object.freeze({ visible: host.style.display !== "none",
          soundEnabled: settings.soundEnabled, restoredSuggestions: restoredSuggestions.size }),
        async destroy() {
          if (destroyed) return false; destroyed = true; observer?.disconnect();
          for (const item of injectedMenuItems) item.remove(); injectedMenuItems.clear();
          for (const item of restoredSuggestions) item.remove(); restoredSuggestions.clear();
          host.remove(); return true;
        },
      };
    },
  }));
})();
