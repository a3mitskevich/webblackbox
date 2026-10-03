import type { CaptureMode, FreezeReason } from "@webblackbox/protocol";

import { getChromeApi } from "./chrome-api.js";

export type ExtensionLocale = "en" | "zh-CN";

const EXTENSION_MESSAGES = {
  en: {
    pageTitlePopup: "WebBlackbox",
    pageTitleOptions: "WebBlackbox Settings",
    pageTitleSessions: "WebBlackbox Sessions",
    pageTitleOffscreen: "WebBlackbox Offscreen Pipeline",
    brandEyebrowChromeExtension: "Chrome Extension",
    modeLite: "Lite",
    modeFull: "Full",
    freezeReasonError: "Error",
    freezeReasonNetwork: "Network",
    freezeReasonMarker: "Marker",
    freezeReasonPerf: "Performance",
    freezeReasonManual: "Manual",
    unknownError: "Unknown error",
    timeAgoSeconds: "{value}s ago",
    timeAgoMinutes: "{value}m ago",
    timeAgoHours: "{value}h ago",
    timeAgoDays: "{value}d ago",
    durationMinutesSeconds: "{minutes}m {seconds}s",
    durationHoursMinutes: "{hours}h {minutes}m",
    popupLabelTab: "Tab",
    popupLabelStatus: "Status",
    popupLabelCapture: "Capture",
    popupLabelIncident: "Incident",
    popupStatusRecordingCurrent: "Recording ({mode})",
    popupStatusRecordingOtherTab: "Recording ({mode}) on Tab {tabId}",
    popupStatusIdleLastCurrent: "Idle (Last {mode})",
    popupStatusIdleLastOtherTab: "Idle (Last {mode} on Tab {tabId})",
    popupStatusIdle: "Idle",
    popupCaptureSummary:
      "{events} events • {errors} errors • {budgetAlerts} budget alerts • {size}",
    popupNoCapturedEvents: "No captured events",
    popupIncidentNone: "none",
    popupRecentFreeze: "{reason} ({timeAgo})",
    popupBadgeAlert: "ALERT",
    popupBadgeRecording: "REC",
    popupBadgeIdle: "IDLE",
    popupStartLite: "Start Lite",
    popupStartFull: "Start Full",
    popupFullVisualCaptureTitle: "Full visual capture",
    popupFullVisualScreenshots: "Screenshots",
    popupFullVisualRecording: "Recording",
    popupFullVisualBoth: "Both",
    popupFullVisualNone: "None",
    popupProfileTitle: "Recording profile",
    popupProfileAuto: "Auto (site rules)",
    popupProfileExtended: "extended",
    popupProfileWillUse: "Records with {name}.",
    popupProfileByRule: "Records with {name} (rule: {rule}).",
    popupProfileDowngraded: "{requested} is limited to allowed sites; {name} is used here.",
    popupProfileRecommends: "Recommended start: {mode}.",
    popupPrivacyBlockedConfirm:
      "The privacy scanner found sensitive data in this archive:\n{error}\n\nExport anyway?",
    popupStop: "Stop",
    popupExport: "Export",
    popupSessions: "Sessions",
    popupOptions: "Options",
    popupMarkerHint: "Marker: Ctrl/Cmd + Shift + M",
    popupExportPassphraseTitle: "Export Passphrase",
    popupExportPassphraseBody:
      "Add an AES-GCM passphrase to encrypt this export. Leave blank to export without encryption.",
    popupPassphraseLabel: "Passphrase",
    popupPassphraseRequired: "Enter a passphrase to encrypt this export.",
    popupCancel: "Cancel",
    popupExporting: "Exporting...",
    popupExported: "Exported: {name}",
    popupExportFailed: "Export failed: {error}",
    popupExportTimedOut:
      "Export did not finish within 2 minutes. Check Chrome downloads or reload the extension and retry.",
    popupExportPrivacyWarningTitle: "Privacy warning",
    popupExportPrivacyWarningAlert:
      "Export completed, but the privacy scanner found {count} possible sensitive item(s): {summary}. Review the archive before sharing.",
    popupStartFailed: "Start failed: {error}",
    popupLiteReloadTitle: "Reload Before Lite Capture?",
    popupLiteReloadBody:
      "Reloading the current page lets Lite capture the page startup, first network requests, and early console/errors. Unsaved page changes may be lost.",
    popupLiteReloadStart: "Reload and Start Lite",
    popupLiteStartWithoutReload: "Start Without Reload",
    popupRingBuffer: "Ring buffer",
    popupArchivePolicyTitle: "Archive Policy",
    popupAlertSensitiveFindings: "Alert when sensitive info is found",
    popupMaxArchiveSizeMb: "Max archive size (MB)",
    popupRecentWindowMinutes: "Recent window (minutes)",
    contentKeyboardMarker: "Keyboard marker",
    optionsSubtitle: "Configure redaction and sampling defaults per browser profile.",
    optionsRingBufferMinutes: "Ring Buffer (minutes)",
    optionsActionWindowMs: "Action Window (ms)",
    optionsMousemoveHz: "Mousemove Sampling (Hz)",
    optionsScrollHz: "Scroll Sampling (Hz)",
    optionsDomFlushMs: "DOM Flush Interval (ms)",
    optionsSnapshotIntervalMs: "DOM Snapshot Interval (ms)",
    optionsScreenshotIdleMs: "Screenshot Idle Interval (ms)",
    optionsScreenshotIdleHelp:
      "Lite screenshots are disabled by default. Set a positive interval only when screenshots are explicitly allowed. Full mode uses this for browser-side screenshot cadence.",
    optionsBodyCaptureMaxBytes: "Network Body Capture Max Bytes",
    optionsBodyCaptureHelp:
      "Lite keeps page-side response-body capture disabled. In the extension, this knob only affects the capped browser-side body capture path used by full mode.",
    optionsFreezeOnError: "Freeze on uncaught errors",
    optionsFreezeHelp:
      "Runtime safety mode keeps performance-trigger freeze disabled for lite/full recording.",
    optionsBlockedSelectors: "Blocked Selectors (one per line)",
    optionsRedactedHeaders: "Redacted Header Names (one per line)",
    optionsBodySensitivePatterns: "Body Sensitive Patterns (one per line)",
    optionsHashSensitiveValues: "Hash sensitive values",
    optionsSave: "Save",
    optionsResetDefaults: "Reset Defaults",
    optionsSavedAt: "Saved at {time}",
    optionsProfilesTitle: "Recording profiles",
    optionsProfilesHint:
      "Profiles decide what is recorded. Presets are read-only: duplicate one to edit it. Site rules only pick a profile; recording always starts manually.",
    optionsProfilesManagedNotice: "Profiles named managed:* come from your organization's policy.",
    optionsProfilesIssues: "Some stored entries were ignored: {issues}",
    optionsProfileDefaultBadge: "default",
    optionsProfileReadOnlyBadge: "read-only",
    optionsProfileExtendedBadge: "extended",
    optionsProfileDuplicate: "Duplicate",
    optionsProfileEdit: "Edit",
    optionsProfileDelete: "Delete",
    optionsProfileMakeDefault: "Make default",
    optionsProfileName: "Name",
    optionsProfileBase: "Recommended start",
    optionsProfileCategories: "Capture levels",
    optionsProfileUnmaskSelectors: "Unmask selectors (never password fields)",
    optionsProfileBodyMimeAllowlist: "Body MIME allowlist (empty = transport default)",
    optionsProfileBodyMaxBytes: "Body max bytes (empty = transport default)",
    optionsProfileIncludeUrls: "Capture bodies only for these URL globs",
    optionsProfileExcludeUrls: "Never capture bodies for these URL globs",
    optionsProfileMousemoveHz: "Pointer rate, Hz (empty = transport default)",
    optionsProfileVisual: "Visual capture",
    optionsProfileVisualPopup: "Chosen in the popup",
    optionsProfileRequireEncryption: "Require an encrypted export",
    optionsProfileBlockOnFindings: "Block export on privacy scanner findings",
    optionsProfileSave: "Apply",
    optionsProfileCancel: "Cancel",
    optionsRulesTitle: "Site rules",
    optionsRulesHint:
      "Highest priority wins. Hosts: example.com, *.stage.example.com, localhost:*. Paths: /admin/**. Query: key=value or key, one per line.",
    optionsRuleAdd: "Add rule",
    optionsRuleName: "Name",
    optionsRuleProfile: "Profile",
    optionsRulePriority: "Priority",
    optionsRuleEnabled: "Enabled",
    optionsRuleHosts: "Hosts",
    optionsRulePaths: "Paths",
    optionsRuleQuery: "Query",
    optionsRuleTitleRegex: "Title regex",
    optionsRuleSelector: "Selector present",
    optionsRuleMetaName: "Meta tag name",
    optionsRuleMetaValue: "Meta tag value",
    optionsRuleIncognito: "Incognito",
    optionsRuleIncognitoAny: "any",
    optionsRuleIncognitoOnly: "only",
    optionsRuleIncognitoNever: "never",
    optionsExtendedHosts: "Hosts allowed for extended profiles (besides rule hosts)",
    optionsProfilesSave: "Save profiles & rules",
    optionsProfilesSaved: "Profiles saved at {time}",
    optionsProfilesExport: "Export JSON",
    optionsProfilesImport: "Import JSON",
    optionsProfilesImportApply: "Apply import",
    optionsProfilesImportNoChanges: "The file matches the current profiles.",
    optionsProfilesImportSummary:
      "Profiles: +{added} −{removed} ~{changed}. Rules: +{rulesAdded} −{rulesRemoved} ~{rulesChanged}.",
    optionsProfilesError: "Error: {error}",
    optionsSandboxTitle: "Redaction sandbox",
    optionsSandboxHint: "Paste a sample to see what the selected profile hides.",
    optionsSandboxKindBody: "Network body",
    optionsSandboxKindEvent: "Event payload (JSON)",
    optionsSandboxKindHeaders: "Headers",
    optionsSandboxKindUrl: "URL",
    optionsSandboxRun: "Preview",
    optionsSandboxUnchanged: "Nothing would be hidden.",
    optionsSandboxInvalidJson: "Event payload must be valid JSON.",
    optionsTitle: "Capture Settings",
    optionsRuntimeProfilesTitle: "Runtime Profiles",
    optionsRuntimeProfilesSummary:
      "WebBlackbox currently exposes two runtime profiles only: lite and full. There is no balanced mode in the shipped extension build.",
    optionsProfileSignals: "Signals: {value}",
    optionsProfileHeavyCapture: "Heavy capture: {value}",
    optionsPerformanceBudgetTitle: "Performance Budget Alerts",
    optionsLcpWarnMs: "LCP warn threshold (ms)",
    optionsRequestWarnMs: "Slow request threshold (ms)",
    optionsErrorRateWarnPct: "Error-rate warn threshold (%)",
    optionsAutoFreezeOnBreach: "Auto-freeze on budget breach",
    optionsLiteProfileSummary: "Page-side lightweight signals with browser-side network metadata.",
    optionsLiteProfileSignals:
      "click / input / scroll / pointer samples / mutation summary / browser-side network baseline",
    optionsLiteProfileHeavyCapture:
      "idle screenshots disabled by default, runtime DOM snapshots stay summary-only, page-side response-body capture disabled",
    optionsFullProfileSummary:
      "Browser-assisted capture with CDP screenshots, navigation, and richer diagnostics.",
    optionsFullProfileSignals:
      "CDP network / navigation / runtime errors plus page-side interaction hints",
    optionsFullProfileHeavyCapture:
      "screenshots stay browser-side, page-side fetch/xhr hooks remain disabled, body capture stays capped",
    sessionsCountSummary: "{total} total · {active} active",
    sessionsSubtitle: "Recent recordings with source context and quick actions.",
    sessionsEmpty: "No sessions captured yet.",
    sessionsStatusLive: "LIVE",
    sessionsStatusStopped: "Stopped",
    sessionsChipMode: "mode {mode}",
    sessionsChipTab: "tab {tabId}",
    sessionsChipStarted: "started {timeAgo}",
    sessionsChipEvents: "events {count}",
    sessionsChipErrors: "errors {count}",
    sessionsChipBudgetAlerts: "budget alerts {count}",
    sessionsChipSize: "size {size}",
    sessionsChipDuration: "duration {duration}",
    sessionsChipEnded: "ended",
    sessionsSid: "sid {sid}",
    sessionsActionExport: "Export",
    sessionsActionStop: "Stop",
    sessionsActionDelete: "Delete",
    sessionsTagsLabel: "Tags (comma-separated)",
    sessionsNotesLabel: "Notes",
    sessionsSaveContext: "Save Context",
    sessionsFallbackTab: "Tab {tabId}",
    sessionsDeletePrompt: "Delete session {sid}? This removes local archive data.",
    sessionsExportDialogTitle: "Export Session",
    sessionsExportDialogBody:
      "Add an AES-GCM passphrase to encrypt this export. Leave blank to export without encryption.",
    sessionsConfirmDeleteTitle: "Confirm Delete",
    sessionsTitle: "Sessions"
  },
  "zh-CN": {
    pageTitlePopup: "WebBlackbox",
    pageTitleOptions: "WebBlackbox 设置",
    pageTitleSessions: "WebBlackbox 会话",
    pageTitleOffscreen: "WebBlackbox 离屏管线",
    brandEyebrowChromeExtension: "Chrome 扩展",
    modeLite: "轻量",
    modeFull: "完整",
    freezeReasonError: "错误",
    freezeReasonNetwork: "网络",
    freezeReasonMarker: "标记",
    freezeReasonPerf: "性能",
    freezeReasonManual: "手动",
    unknownError: "未知错误",
    timeAgoSeconds: "{value} 秒前",
    timeAgoMinutes: "{value} 分钟前",
    timeAgoHours: "{value} 小时前",
    timeAgoDays: "{value} 天前",
    durationMinutesSeconds: "{minutes} 分 {seconds} 秒",
    durationHoursMinutes: "{hours} 小时 {minutes} 分",
    popupLabelTab: "标签页",
    popupLabelStatus: "状态",
    popupLabelCapture: "采集",
    popupLabelIncident: "事件",
    popupStatusRecordingCurrent: "录制中（{mode}）",
    popupStatusRecordingOtherTab: "录制中（{mode}，标签页 {tabId}）",
    popupStatusIdleLastCurrent: "空闲（最近一次 {mode}）",
    popupStatusIdleLastOtherTab: "空闲（最近一次 {mode}，标签页 {tabId}）",
    popupStatusIdle: "空闲",
    popupCaptureSummary: "{events} 个事件 • {errors} 个错误 • {budgetAlerts} 个预算告警 • {size}",
    popupNoCapturedEvents: "暂无采集事件",
    popupIncidentNone: "无",
    popupRecentFreeze: "{reason}（{timeAgo}）",
    popupBadgeAlert: "告警",
    popupBadgeRecording: "录制",
    popupBadgeIdle: "空闲",
    popupStartLite: "开始轻量模式",
    popupStartFull: "开始完整模式",
    popupFullVisualCaptureTitle: "完整模式画面采集",
    popupFullVisualScreenshots: "截图",
    popupFullVisualRecording: "录屏",
    popupFullVisualBoth: "截图 + 录屏",
    popupFullVisualNone: "无",
    popupProfileTitle: "录制配置",
    popupProfileAuto: "自动（站点规则）",
    popupProfileExtended: "扩展",
    popupProfileWillUse: "将使用 {name} 录制。",
    popupProfileByRule: "将使用 {name} 录制（规则：{rule}）。",
    popupProfileDowngraded: "{requested} 仅限允许的站点；此处使用 {name}。",
    popupProfileRecommends: "推荐启动方式：{mode}。",
    popupPrivacyBlockedConfirm: "隐私扫描器在此归档中发现敏感数据：\n{error}\n\n仍要导出吗？",
    popupStop: "停止",
    popupExport: "导出",
    popupSessions: "会话",
    popupOptions: "设置",
    popupMarkerHint: "标记快捷键：Ctrl/Cmd + Shift + M",
    popupExportPassphraseTitle: "导出口令",
    popupExportPassphraseBody: "填写 AES-GCM 口令可加密导出；留空则不加密导出。",
    popupPassphraseLabel: "口令",
    popupPassphraseRequired: "填写口令将加密导出。",
    popupCancel: "取消",
    popupExporting: "正在导出...",
    popupExported: "已导出：{name}",
    popupExportFailed: "导出失败：{error}",
    popupExportTimedOut: "导出 2 分钟内未完成。请检查 Chrome 下载列表，或重新加载扩展后重试。",
    popupExportPrivacyWarningTitle: "隐私告警",
    popupExportPrivacyWarningAlert:
      "导出已完成，但隐私扫描发现 {count} 个可能的敏感项：{summary}。分享前请先检查归档内容。",
    popupStartFailed: "启动失败：{error}",
    popupLiteReloadTitle: "启动轻量模式前刷新页面？",
    popupLiteReloadBody:
      "刷新当前页面可让轻量模式采集页面启动、首轮网络请求和早期 console/error。未保存的页面内容可能会丢失。",
    popupLiteReloadStart: "刷新并开始轻量模式",
    popupLiteStartWithoutReload: "不刷新，直接开始",
    popupRingBuffer: "环形缓冲区",
    popupArchivePolicyTitle: "归档策略",
    popupAlertSensitiveFindings: "发现敏感信息时提醒",
    popupMaxArchiveSizeMb: "归档最大体积（MB）",
    popupRecentWindowMinutes: "最近窗口（分钟）",
    contentKeyboardMarker: "键盘标记",
    optionsSubtitle: "按浏览器配置文件设置默认脱敏与采样参数。",
    optionsRingBufferMinutes: "环形缓冲区（分钟）",
    optionsActionWindowMs: "动作窗口（毫秒）",
    optionsMousemoveHz: "鼠标移动采样率（Hz）",
    optionsScrollHz: "滚动采样率（Hz）",
    optionsDomFlushMs: "DOM 刷新间隔（毫秒）",
    optionsSnapshotIntervalMs: "DOM 快照间隔（毫秒）",
    optionsScreenshotIdleMs: "空闲截图间隔（毫秒）",
    optionsScreenshotIdleHelp:
      "轻量模式默认关闭空闲截图。仅在明确允许截图时设置为正数。完整模式会将其用于浏览器侧截图节奏。",
    optionsBodyCaptureMaxBytes: "网络响应体采集上限（字节）",
    optionsBodyCaptureHelp:
      "轻量模式会关闭页面侧响应体采集。在扩展中，这个参数只影响完整模式使用的浏览器侧限量响应体采集路径。",
    optionsFreezeOnError: "遇到未捕获错误时冻结",
    optionsFreezeHelp: "运行安全模式会对轻量/完整录制关闭性能触发冻结。",
    optionsBlockedSelectors: "屏蔽的选择器（每行一个）",
    optionsRedactedHeaders: "需脱敏的请求头名称（每行一个）",
    optionsBodySensitivePatterns: "请求体敏感模式（每行一个）",
    optionsHashSensitiveValues: "对敏感值做哈希",
    optionsSave: "保存",
    optionsResetDefaults: "恢复默认值",
    optionsSavedAt: "已保存于 {time}",
    optionsProfilesTitle: "录制配置",
    optionsProfilesHint:
      "配置决定录制哪些内容。预设为只读：复制后即可编辑。站点规则只选择配置，录制始终手动开始。",
    optionsProfilesManagedNotice: "名为 managed:* 的配置来自组织策略。",
    optionsProfilesIssues: "已忽略部分无效的存储条目：{issues}",
    optionsProfileDefaultBadge: "默认",
    optionsProfileReadOnlyBadge: "只读",
    optionsProfileExtendedBadge: "扩展",
    optionsProfileDuplicate: "复制",
    optionsProfileEdit: "编辑",
    optionsProfileDelete: "删除",
    optionsProfileMakeDefault: "设为默认",
    optionsProfileName: "名称",
    optionsProfileBase: "推荐启动方式",
    optionsProfileCategories: "采集级别",
    optionsProfileUnmaskSelectors: "取消遮罩的选择器（密码字段除外）",
    optionsProfileBodyMimeAllowlist: "响应体 MIME 白名单（留空 = 传输默认）",
    optionsProfileBodyMaxBytes: "响应体最大字节数（留空 = 传输默认）",
    optionsProfileIncludeUrls: "仅采集这些 URL 模式的响应体",
    optionsProfileExcludeUrls: "从不采集这些 URL 模式的响应体",
    optionsProfileMousemoveHz: "指针采样频率 Hz（留空 = 传输默认）",
    optionsProfileVisual: "视觉采集",
    optionsProfileVisualPopup: "在弹窗中选择",
    optionsProfileRequireEncryption: "导出必须加密",
    optionsProfileBlockOnFindings: "隐私扫描发现问题时阻止导出",
    optionsProfileSave: "应用",
    optionsProfileCancel: "取消",
    optionsRulesTitle: "站点规则",
    optionsRulesHint:
      "优先级最高者生效。主机：example.com、*.stage.example.com、localhost:*。路径：/admin/**。查询：每行 key=value 或 key。",
    optionsRuleAdd: "添加规则",
    optionsRuleName: "名称",
    optionsRuleProfile: "配置",
    optionsRulePriority: "优先级",
    optionsRuleEnabled: "启用",
    optionsRuleHosts: "主机",
    optionsRulePaths: "路径",
    optionsRuleQuery: "查询参数",
    optionsRuleTitleRegex: "标题正则",
    optionsRuleSelector: "存在选择器",
    optionsRuleMetaName: "Meta 标签名称",
    optionsRuleMetaValue: "Meta 标签值",
    optionsRuleIncognito: "无痕模式",
    optionsRuleIncognitoAny: "任意",
    optionsRuleIncognitoOnly: "仅无痕",
    optionsRuleIncognitoNever: "非无痕",
    optionsExtendedHosts: "允许扩展配置的主机（规则主机之外）",
    optionsProfilesSave: "保存配置和规则",
    optionsProfilesSaved: "配置已保存于 {time}",
    optionsProfilesExport: "导出 JSON",
    optionsProfilesImport: "导入 JSON",
    optionsProfilesImportApply: "应用导入",
    optionsProfilesImportNoChanges: "文件与当前配置一致。",
    optionsProfilesImportSummary:
      "配置：+{added} −{removed} ~{changed}。规则：+{rulesAdded} −{rulesRemoved} ~{rulesChanged}。",
    optionsProfilesError: "错误：{error}",
    optionsSandboxTitle: "脱敏沙箱",
    optionsSandboxHint: "粘贴示例，查看所选配置会隐藏哪些内容。",
    optionsSandboxKindBody: "网络响应体",
    optionsSandboxKindEvent: "事件负载（JSON）",
    optionsSandboxKindHeaders: "请求头",
    optionsSandboxKindUrl: "URL",
    optionsSandboxRun: "预览",
    optionsSandboxUnchanged: "没有内容会被隐藏。",
    optionsSandboxInvalidJson: "事件负载必须是有效的 JSON。",
    optionsTitle: "采集设置",
    optionsRuntimeProfilesTitle: "运行时配置",
    optionsRuntimeProfilesSummary:
      "当前扩展仅提供两种运行时配置：lite 与 full。正式构建中不包含 balanced 模式。",
    optionsProfileSignals: "信号：{value}",
    optionsProfileHeavyCapture: "重采集能力：{value}",
    optionsPerformanceBudgetTitle: "性能预算告警",
    optionsLcpWarnMs: "LCP 告警阈值（毫秒）",
    optionsRequestWarnMs: "慢请求阈值（毫秒）",
    optionsErrorRateWarnPct: "错误率告警阈值（%）",
    optionsAutoFreezeOnBreach: "预算超限时自动冻结",
    optionsLiteProfileSummary: "页面侧轻量信号，结合浏览器侧网络元数据。",
    optionsLiteProfileSignals: "点击 / 输入 / 滚动 / 指针采样 / 变更摘要 / 浏览器侧网络基线",
    optionsLiteProfileHeavyCapture:
      "默认关闭空闲截图，运行时 DOM 快照保持摘要模式，页面侧响应体采集关闭",
    optionsFullProfileSummary: "浏览器辅助采集，提供 CDP 截图、导航与更丰富的诊断信息。",
    optionsFullProfileSignals: "CDP 网络 / 导航 / 运行时错误，加上页面侧交互提示",
    optionsFullProfileHeavyCapture:
      "截图保留在浏览器侧，页面侧 fetch/xhr hook 保持关闭，响应体采集仍有上限",
    sessionsCountSummary: "共 {total} 个 · 进行中 {active} 个",
    sessionsSubtitle: "近期录制结果，附带来源上下文和快捷操作。",
    sessionsEmpty: "还没有采集到会话。",
    sessionsStatusLive: "进行中",
    sessionsStatusStopped: "已停止",
    sessionsChipMode: "模式 {mode}",
    sessionsChipTab: "标签页 {tabId}",
    sessionsChipStarted: "开始于 {timeAgo}",
    sessionsChipEvents: "事件 {count}",
    sessionsChipErrors: "错误 {count}",
    sessionsChipBudgetAlerts: "预算告警 {count}",
    sessionsChipSize: "体积 {size}",
    sessionsChipDuration: "时长 {duration}",
    sessionsChipEnded: "结束时间",
    sessionsSid: "sid {sid}",
    sessionsActionExport: "导出",
    sessionsActionStop: "停止",
    sessionsActionDelete: "删除",
    sessionsTagsLabel: "标签（逗号分隔）",
    sessionsNotesLabel: "备注",
    sessionsSaveContext: "保存上下文",
    sessionsFallbackTab: "标签页 {tabId}",
    sessionsDeletePrompt: "删除会话 {sid}？这会移除本地归档数据。",
    sessionsExportDialogTitle: "导出会话",
    sessionsExportDialogBody: "填写 AES-GCM 口令可加密导出；留空则不加密导出。",
    sessionsConfirmDeleteTitle: "确认删除",
    sessionsTitle: "会话"
  }
} as const;

export type ExtensionMessageKey = keyof (typeof EXTENSION_MESSAGES)["en"];

export function createExtensionI18n(
  options: {
    pageTitleKey?: ExtensionMessageKey;
  } = {}
) {
  const locale = getExtensionLocale();

  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;

    if (options.pageTitleKey) {
      document.title = translateExtensionMessage(locale, options.pageTitleKey);
    }
  }

  return {
    locale,
    t: (key: ExtensionMessageKey, vars?: Record<string, string | number>) =>
      translateExtensionMessage(locale, key, vars),
    formatMode: (mode: CaptureMode) => formatExtensionMode(locale, mode),
    formatFreezeReason: (reason: FreezeReason) => formatExtensionFreezeReason(locale, reason),
    formatRelativeTime: (timestamp: number, now: number) =>
      formatExtensionRelativeTime(locale, timestamp, now),
    formatDuration: (startedAt: number, endedAt: number) =>
      formatExtensionDuration(locale, startedAt, endedAt),
    formatByteSize: (bytes: number) => formatExtensionByteSize(bytes)
  };
}

export function getExtensionLocale(): ExtensionLocale {
  const chromeApi = getChromeApi();
  const uiLanguage = chromeApi?.i18n?.getUILanguage?.();
  const navigatorLanguage =
    typeof navigator !== "undefined" ? (navigator.language ?? navigator.languages?.[0]) : undefined;

  return normalizeExtensionLocale(uiLanguage ?? navigatorLanguage);
}

export function normalizeExtensionLocale(candidate?: string | null): ExtensionLocale {
  if (typeof candidate !== "string") {
    return "en";
  }

  return candidate.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function translateExtensionMessage(
  locale: ExtensionLocale,
  key: ExtensionMessageKey,
  vars: Record<string, string | number> = {}
): string {
  const template = EXTENSION_MESSAGES[locale][key] ?? EXTENSION_MESSAGES.en[key] ?? key;

  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name] ?? "") : ""
  );
}

export function formatExtensionMode(locale: ExtensionLocale, mode: CaptureMode): string {
  return translateExtensionMessage(locale, mode === "full" ? "modeFull" : "modeLite");
}

export function formatExtensionFreezeReason(locale: ExtensionLocale, reason: FreezeReason): string {
  const key: Record<FreezeReason, ExtensionMessageKey> = {
    error: "freezeReasonError",
    network: "freezeReasonNetwork",
    marker: "freezeReasonMarker",
    perf: "freezeReasonPerf",
    manual: "freezeReasonManual"
  };

  return translateExtensionMessage(locale, key[reason]);
}

export function formatExtensionRelativeTime(
  locale: ExtensionLocale,
  timestamp: number,
  now: number
): string {
  const deltaMs = Math.max(0, now - timestamp);
  const seconds = Math.floor(deltaMs / 1000);

  if (seconds < 60) {
    return translateExtensionMessage(locale, "timeAgoSeconds", {
      value: seconds
    });
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return translateExtensionMessage(locale, "timeAgoMinutes", {
      value: minutes
    });
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return translateExtensionMessage(locale, "timeAgoHours", {
      value: hours
    });
  }

  const days = Math.floor(hours / 24);
  return translateExtensionMessage(locale, "timeAgoDays", {
    value: days
  });
}

export function formatExtensionDuration(
  locale: ExtensionLocale,
  startedAt: number,
  endedAt: number
): string {
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return translateExtensionMessage(locale, "durationMinutesSeconds", {
      minutes,
      seconds
    });
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return translateExtensionMessage(locale, "durationHoursMinutes", {
    hours,
    minutes: remMinutes
  });
}

export function formatExtensionByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  const kb = bytes / 1024;

  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }

  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}
