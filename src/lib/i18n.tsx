import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { ImportField } from "./excelMapping";
import type { DailyJudgement } from "./progress";
import type { TaskPriority, TaskStatus } from "./types";

/**
 * UI language. "en" is the default; the preference is a device-local display
 * setting stored like the theme (default value keeps the key absent). Only the
 * interface chrome translates — task data and the Excel worklog headers are a
 * fixed contract and never follow this setting.
 */
export type Language = "en" | "zh";

export type PeriodNoun = "week" | "month" | "year";

const STORAGE_KEY = "pm:lang";

function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "zh";
}

export function getStoredLanguage(): Language {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isLanguage(raw) ? raw : "en";
  } catch {
    return "en";
  }
}

export function setStoredLanguage(lang: Language): void {
  try {
    if (lang === "en") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, lang);
    }
  } catch {
    /* storage may be unavailable (private mode); the in-memory state still applies */
  }
}

/** Mirror the language onto the document (lang attribute + title), like applyTheme. */
export function applyLanguage(lang: Language): void {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.title = MESSAGES[lang].appTitle;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const en = {
  appTitle: "Project Manager",
  nav: {
    label: "Main navigation",
    today: "Today",
    projects: "Projects",
    calendar: "Calendar",
    next: "Next",
    search: "Search",
    settings: "Settings"
  },
  common: {
    noProject: "No project",
    allProjects: "All projects",
    unknownProject: "Unknown project",
    project: "Project",
    notes: "Notes",
    cancel: "Cancel",
    confirm: "Confirm",
    delete: "Delete",
    archive: "Archive",
    rename: "Rename"
  },
  status: {
    inbox: "Inbox",
    todo: "To do",
    doing: "Doing",
    waiting: "Waiting",
    blocked: "Blocked",
    done: "Done",
    cancelled: "Cancelled"
  } satisfies Record<TaskStatus, string>,
  priority: {
    low: "Low",
    medium: "Medium",
    high: "High",
    urgent: "Urgent"
  } satisfies Record<TaskPriority, string>,
  judgement: {
    blocked: "Has blockers",
    coreStrong: "Core on track",
    hasOutput: "Output made",
    low: "Low progress"
  } satisfies Record<DailyJudgement, string>,
  offline: {
    offline: "Offline",
    savedOffline: (n: number) => `${plural(n, "change")} saved offline`,
    syncIssue: (error: string | null) => (error ? `Sync issue: ${error}` : "Sync issue"),
    syncing: (n: number) => (n > 0 ? `Syncing ${plural(n, "change")}` : "Syncing"),
    queued: (n: number) => `${plural(n, "change")} queued`,
    pending: (n: number) => `${plural(n, "change")} pending`,
    syncNow: "Sync now"
  },
  today: {
    title: "Today",
    subtitle: (n: number, pct: number) => `${plural(n, "task")} · Weighted ${pct}%`,
    dailySummary: "Daily Summary",
    addTask: "Add task",
    rollover: "Roll over unfinished",
    rolloverAria: "Move this day's unfinished tasks to the next day",
    empty: (date: string) => `No tasks for ${date} yet. Tap “Add task” to start.`,
    prevDay: "Previous day",
    nextDay: "Next day",
    backToToday: "Return to today"
  },
  progress: {
    heroAria: (pct: number) => `Weighted progress ${pct}%`,
    weighted: "Weighted progress",
    core: "Core task progress",
    outputTasks: "Tasks with output",
    blockedTasks: "Blocked",
    judgementLabel: "Today's verdict"
  },
  taskTable: {
    tableAria: "Task table",
    importance: "Importance",
    progressHeader: "Progress",
    date: "Date",
    task: "Task",
    output: "Today's output",
    blocker: "Blocked on",
    nextStep: "Tomorrow's first step",
    newTask: "New task…",
    taskActions: "Task actions",
    copyToYesterday: "Copy to yesterday",
    copyToTomorrow: "Copy to tomorrow",
    moveToYesterday: "Move to yesterday",
    moveToTomorrow: "Move to tomorrow",
    deleteTask: "Delete task",
    deletePrompt: "Delete this task permanently?",
    confirmDelete: "Confirm delete",
    noteAria: "Note",
    showing: (visible: number, total: number) => `Showing ${visible} of ${total}. Scroll for more, or search to narrow down.`
  },
  composer: {
    newTask: "New task",
    newTaskAria: "New task title",
    importanceAria: "Importance",
    importance: { 1: "1 core", 2: "2 maintain", 3: "3 optional", 4: "4 defer" } as Record<1 | 2 | 3 | 4, string>,
    dateAria: "Task date",
    createTask: "Create task",
    newProject: "New project",
    newProjectAria: "New project name",
    createProject: "Create project"
  },
  projectsPage: {
    title: "Projects",
    subtitle: (n: number, pct: number) => `${plural(n, "task")} · average ${pct}%`
  },
  projectList: {
    archived: "Archived",
    noArchived: "No archived projects.",
    archivePrompt: "Archive this project?",
    deletePrompt: "Delete this project?",
    confirmArchive: "Confirm archive",
    confirmDelete: "Confirm delete",
    options: "Options",
    optionsFor: (name: string) => `Options for ${name}`,
    renameAria: (name: string) => `Rename ${name}`,
    saveName: "Save name",
    restore: (name: string) => `Restore ${name}`,
    restoreTitle: "Move back to projects"
  },
  next: {
    title: "Next",
    subtitle: (n: number) => `${n} saved ideas and future tasks`,
    newProject: "New Next project",
    createProject: "Create Next project",
    addIdea: "Add an idea",
    addIdeaFor: (name: string) => `New idea for ${name}`,
    addIdeaAction: (name: string) => `Add idea for ${name}`,
    ideaAria: "Next idea",
    deleteIdea: "Delete next idea",
    deleteGroupTitle: "Delete Next project",
    confirmDeleteGroup: "Confirm delete Next project",
    confirmDeleteFor: (name: string) => `Confirm delete ${name}`,
    deleteFor: (name: string) => `Delete ${name}`,
    projectLabel: "Project",
    renameAria: (name: string) => `Rename ${name}`,
    noIdeas: "No saved ideas yet.",
    noProjects: "No Next projects yet. Create one above to save future ideas.",
    boardAria: "Next idea board"
  },
  search: {
    title: "Search",
    subtitle: (tasks: number, ideas: number) => `${tasks} matching tasks · ${ideas} Next ideas`,
    placeholder: "Search projects, tasks, output, blockers",
    searchAria: "Search tasks",
    filterProject: "Filter project",
    filterStatus: "Filter status",
    filterPriority: "Filter priority",
    anyProgress: "Any progress",
    anyImportance: "Any importance",
    nextIdeas: "Next ideas",
    nextResultsAria: "Next ideas results",
    untitledIdea: "Untitled idea",
    noNextMatch: "No Next ideas match this search.",
    nextFallback: "Next"
  },
  calendar: {
    title: "Calendar",
    viewAria: "View",
    metricAria: "Completion metric",
    week: "Week",
    month: "Month",
    year: "Year",
    weighted: "Weighted",
    doneRate: "Done rate",
    prevPeriod: "Previous period",
    nextPeriod: "Next period",
    jumpCurrent: "Jump to current period",
    summaryAria: "Period summary",
    weightedCompletion: "Weighted completion",
    completionAria: (v: number) => `Completion ${v}%`,
    tasks: "Tasks",
    done: "Done",
    output: "Output",
    blocked: "Blocked",
    dotOutput: (n: number) => `${n} output`,
    dotBlocked: (n: number) => `${n} blocked`,
    vsLast: (p: PeriodNoun) => `vs last ${p}`,
    newBadge: "New",
    pt: (delta: number) => `${delta > 0 ? "+" : ""}${delta} pt`,
    noDataLast: (p: PeriodNoun) => `no data last ${p}`,
    bestDay: "Best day",
    bestWeek: "Best week",
    bestMonth: "Best month",
    metricValue: (v: number, metric: "weighted" | "done") => `${v}% ${metric === "done" ? "done" : "weighted"}`,
    noActiveDay: "no active day",
    noActiveWeek: "no active week",
    activeDays: "Active days",
    tasksDone: (n: number, done: number) => `${plural(n, "task")} · ${done} done`,
    coreFocus: "Core focus (P1)",
    coreTasks: (n: number) => plural(n, "core task"),
    noCoreTasks: "no core tasks",
    insightsAria: (p: PeriodNoun) => `${p} insights`,
    emptyInsights: (p: PeriodNoun) => `No records this ${p} yet. Open a day and add tasks to see ${p}ly insights.`,
    projectFocus: "Project focus",
    weightShareTitle: (name: string, pct: number, p: PeriodNoun) => `${name}: ${pct}% of this ${p}'s weight`,
    more: (n: number) => `+${n} more`,
    focusMix: "Focus mix",
    mixAria: "Importance distribution",
    bandTitle: (importance: number, n: number) => `P${importance}: ${plural(n, "task")}`,
    bandTasks: (n: number) => plural(n, "task"),
    weeklyOutput: "Weekly output",
    monthlyOutput: "Monthly output",
    blockers: "Blockers",
    outputEmptyWeek: "No outputs recorded this week. Fill “Today's output” on a task to build your weekly review.",
    outputEmptyMonth: "No outputs recorded this month. Fill “Today's output” on a task to build your monthly review.",
    showLess: "Show less",
    showAll: (n: number) => `Show all ${n}`,
    completionByWeek: "Completion by week",
    weeks: (n: number) => plural(n, "week"),
    weekN: (i: number) => `W${i}`,
    currentStreak: "Current streak",
    longestStreak: "Longest streak",
    streakDays: (n: number) => `${n}d`,
    daysAtGoal: (goal: number) => `days ≥ ${goal}%`,
    inYear: (year: string) => `in ${year}`,
    noRecords: "no records yet",
    heatmapAria: (year: string) => `${year} completion heatmap`,
    completionByMonth: "Completion by month"
  },
  theme: {
    label: "Theme",
    light: "Light",
    dark: "Dark",
    system: "System"
  },
  settings: {
    title: "Settings",
    signedIn: "Signed in",
    recordDays: "Days tracked",
    taskCount: "Tasks",
    avgProgress: "Avg progress",
    outputDays: "Days with output",
    projects: "Projects",
    pending: "Pending",
    lastSync: "Last sync",
    lastExport: "Last export",
    never: "Never",
    appearance: "Appearance",
    heroAnim: "Weighted progress animation",
    heroFlow: "Flow",
    heroShimmer: "Shimmer",
    heroHint:
      "Pixel animation for the Today page's weighted-progress hero: Flow drifts pixels out along the fill and fades them; Shimmer twinkles in place.",
    meterStyle: "Progress bar style",
    meterGlass: "Liquid glass",
    meterFlat: "Minimal",
    meterHint:
      "Applies to the Today core-progress bar, the project list's completion meters, the calendar's bars, and the heatmap tiles. Liquid glass is the classic v2 material; Minimal is the flat solid one.",
    language: "Language",
    appLanguage: "App language",
    languageHint: "Applies to the entire interface. Task data and Excel headers stay unchanged.",
    excel: "Excel",
    sync: "Sync",
    syncNow: "Sync now",
    forceResync: "Force full resync",
    forceResyncHint:
      "Clears the local cache and re-downloads everything from the cloud. Use only after the cloud data was wiped and re-imported, to remove duplicate tasks.",
    forceResyncConfirm:
      "Force full resync clears the local cache and re-downloads all data from the cloud. Use it only when the cloud was wiped and re-imported, or duplicate/stale tasks appear on this device. Continue?",
    syncError: "Sync error",
    conflicts: "Conflicts",
    conflictDetails: "Synchronization conflict details",
    backup: "Backup",
    downloadJson: "Download JSON backup",
    restoreJson: "Restore from JSON",
    restoring: "Restoring",
    backupHint:
      "The JSON backup contains every field of every project, task, and Next idea. Restoring merges the file into the cloud data (matching records are overwritten, nothing is deleted).",
    restoreConfirm: (projects: number, tasks: number, nextProjects: number, nextIdeas: number) =>
      `Restore ${projects} projects, ${tasks} tasks, ${nextProjects} Next projects and ${nextIdeas} ideas from this file? Matching records will be overwritten.`,
    restoreDone: (projects: number, tasks: number, nextProjects: number, nextIdeas: number) =>
      `Restored ${projects} projects, ${tasks} tasks, ${nextProjects} Next projects, ${nextIdeas} ideas.`,
    restoreInvalid: "This file is not a valid backup JSON.",
    restoreFailed: "Restore failed",
    backupDownloaded: "Backup downloaded.",
    backupFailed: "Backup failed",
    security: "Security",
    changePasscode: "Change passcode",
    passcodeHint:
      "Change the 4-digit sign-in passcode. It takes effect immediately; the old passcode — including the initial one from deployment — stops working. Other signed-in devices are signed out.",
    iphone: "iPhone",
    installNote: "In Safari, open Share, choose Add to Home Screen, then launch Projects from the Home Screen icon.",
    signOut: "Sign out",
    signOutPendingConfirm: (n: number) =>
      `${plural(n, "change")} could not be synced and will be lost if you sign out now. Sign out anyway?`
  },
  importer: {
    pick: "Import Excel",
    reading: "Reading",
    worksheet: "Worksheet",
    columnsDetected: (n: number) => `${plural(n, "column")} detected`,
    headerRow: (n: number) => `Header row ${n}`,
    rowsReady: (n: number) => `${plural(n, "task row")} ready`,
    confirmImport: "Confirm Import",
    noRows: "No mapped task rows found.",
    importedSummary: (rows: number, created: number, updated: number, skipped: number) =>
      `Imported ${rows} rows. Created ${created}, updated ${updated}, skipped ${skipped}.`,
    couldNotRead: "Could not read workbook",
    emptyWorkbook: "Workbook does not contain any worksheets.",
    importFailed: "Import failed",
    fields: {
      skip: "Skip",
      id: "ID",
      external_key: "External key",
      project: "Project",
      title: "Title",
      status: "Status",
      priority: "Priority",
      importance: "Importance",
      due_date: "Due date",
      start_date: "Start date",
      next_action: "Next action",
      notes: "Notes",
      description: "Description",
      progress: "Progress",
      blocker: "Blocker",
      output: "Output"
    } satisfies Record<ImportField, string>
  },
  exporter: {
    export: "Export Excel",
    working: "Working",
    exportR2: "Export + R2",
    downloaded: "Export downloaded.",
    downloadedUploaded: "Export downloaded and uploaded.",
    exportFailed: "Export failed"
  },
  login: {
    keypadAria: "Password keypad",
    welcome: "Welcome back",
    enterPasscode: "Enter your 4-digit passcode",
    setTitle: "Set your passcode",
    choosePasscode: "Choose a 4-digit passcode",
    confirmTitle: "Confirm passcode",
    reenterSame: "Enter the same passcode again",
    wrongPasscode: "Wrong passcode — try again",
    mismatch: "Passcodes didn't match — try again",
    couldNotSave: "Could not save passcode",
    setupToken: "Setup token",
    setupTokenHint: "Enter the one-time setup token from your deployment settings",
    setupUnavailable: "First-run setup is disabled until SETUP_TOKEN is configured",
    clear: "Clear",
    deleteKey: "Delete"
  },
  passcode: {
    dialogAria: "Change passcode",
    currentTitle: "Change passcode",
    currentSub: "Enter your current passcode",
    nextTitle: "New passcode",
    nextSub: "Choose a new 4-digit passcode",
    confirmTitle: "Confirm passcode",
    confirmSub: "Enter the new passcode again",
    doneTitle: "Passcode updated",
    doneSub: "Use it next time you sign in",
    wrong: "Wrong passcode — try again",
    mismatch: "Passcodes didn't match — try again",
    couldNotUpdate: "Could not update passcode"
  }
};

export type Messages = typeof en;

const ZH_PERIOD: Record<PeriodNoun, string> = { week: "本周", month: "本月", year: "今年" };
const ZH_VS_LAST: Record<PeriodNoun, string> = { week: "较上周", month: "较上月", year: "较去年" };
const ZH_NO_DATA: Record<PeriodNoun, string> = { week: "上周无数据", month: "上月无数据", year: "去年无数据" };

const zh: Messages = {
  appTitle: "项目管理",
  nav: {
    label: "主导航",
    today: "今天",
    projects: "项目",
    calendar: "日历",
    next: "想法",
    search: "搜索",
    settings: "设置"
  },
  common: {
    noProject: "无项目",
    allProjects: "全部项目",
    unknownProject: "未知项目",
    project: "项目",
    notes: "备注",
    cancel: "取消",
    confirm: "确认",
    delete: "删除",
    archive: "归档",
    rename: "重命名"
  },
  status: {
    inbox: "收件箱",
    todo: "待办",
    doing: "进行中",
    waiting: "等待",
    blocked: "卡住",
    done: "完成",
    cancelled: "已取消"
  },
  priority: {
    low: "低",
    medium: "中",
    high: "高",
    urgent: "紧急"
  },
  judgement: {
    blocked: "有卡点",
    coreStrong: "核心推进好",
    hasOutput: "有产出",
    low: "低推进"
  },
  offline: {
    offline: "离线",
    savedOffline: (n) => `${n} 项更改已离线保存`,
    syncIssue: (error) => (error ? `同步异常：${error}` : "同步异常"),
    syncing: (n) => (n > 0 ? `正在同步 ${n} 项更改` : "同步中"),
    queued: (n) => `${n} 项更改排队中`,
    pending: (n) => `${n} 项更改待同步`,
    syncNow: "立即同步"
  },
  today: {
    title: "今天",
    subtitle: (n, pct) => `${n} 个任务 · 加权推进 ${pct}%`,
    dailySummary: "每日总结",
    addTask: "添加任务",
    rollover: "顺延未完成",
    rolloverAria: "把当天未完成的任务移到明天",
    empty: (date) => `${date} 还没有任务，点「添加任务」开始记录。`,
    prevDay: "前一天",
    nextDay: "后一天",
    backToToday: "回到今天"
  },
  progress: {
    heroAria: (pct) => `加权推进 ${pct}%`,
    weighted: "加权推进",
    core: "核心任务进度",
    outputTasks: "有产出任务数",
    blockedTasks: "卡点数",
    judgementLabel: "今日判断"
  },
  taskTable: {
    tableAria: "任务表格",
    importance: "重要程度",
    progressHeader: "进度",
    date: "日期",
    task: "任务",
    output: "今日产出",
    blocker: "卡住的地方",
    nextStep: "明天第一步",
    newTask: "新任务…",
    taskActions: "任务操作",
    copyToYesterday: "复制到昨天",
    copyToTomorrow: "复制到明天",
    moveToYesterday: "移到昨天",
    moveToTomorrow: "移到明天",
    deleteTask: "删除任务",
    deletePrompt: "永久删除这个任务？",
    confirmDelete: "确认删除",
    noteAria: "备注",
    showing: (visible, total) => `已显示 ${visible} / ${total} 条，向下滚动加载更多，或用搜索缩小范围。`
  },
  composer: {
    newTask: "新任务",
    newTaskAria: "新任务标题",
    importanceAria: "重要程度",
    importance: { 1: "1 核心", 2: "2 维持", 3: "3 可选", 4: "4 暂缓" },
    dateAria: "任务日期",
    createTask: "创建任务",
    newProject: "新项目",
    newProjectAria: "新项目名称",
    createProject: "创建项目"
  },
  projectsPage: {
    title: "项目",
    subtitle: (n, pct) => `${n} 个任务 · 平均推进 ${pct}%`
  },
  projectList: {
    archived: "已归档",
    noArchived: "暂无归档项目。",
    archivePrompt: "归档这个项目？",
    deletePrompt: "删除这个项目？",
    confirmArchive: "确认归档",
    confirmDelete: "确认删除",
    options: "操作",
    optionsFor: (name) => `${name} 的操作`,
    renameAria: (name) => `重命名 ${name}`,
    saveName: "保存名称",
    restore: (name) => `恢复 ${name}`,
    restoreTitle: "移回项目列表"
  },
  next: {
    title: "想法",
    subtitle: (n) => `${n} 条已保存的想法与未来任务`,
    newProject: "新想法分组",
    createProject: "创建想法分组",
    addIdea: "添加想法",
    addIdeaFor: (name) => `为「${name}」添加想法`,
    addIdeaAction: (name) => `添加想法到「${name}」`,
    ideaAria: "想法",
    deleteIdea: "删除想法",
    deleteGroupTitle: "删除想法分组",
    confirmDeleteGroup: "确认删除想法分组",
    confirmDeleteFor: (name) => `确认删除「${name}」`,
    deleteFor: (name) => `删除「${name}」`,
    projectLabel: "分组",
    renameAria: (name) => `重命名「${name}」`,
    noIdeas: "还没有想法。",
    noProjects: "还没有想法分组。先在上面创建一个，用来收集未来的想法。",
    boardAria: "想法看板"
  },
  search: {
    title: "搜索",
    subtitle: (tasks, ideas) => `${tasks} 个匹配任务 · ${ideas} 条想法`,
    placeholder: "搜索项目、任务、产出、卡点",
    searchAria: "搜索任务",
    filterProject: "筛选项目",
    filterStatus: "筛选进度",
    filterPriority: "筛选重要度",
    anyProgress: "不限进度",
    anyImportance: "不限重要度",
    nextIdeas: "想法",
    nextResultsAria: "想法搜索结果",
    untitledIdea: "未命名想法",
    noNextMatch: "没有匹配的想法。",
    nextFallback: "想法"
  },
  calendar: {
    title: "日历",
    viewAria: "视图",
    metricAria: "完成度指标",
    week: "周",
    month: "月",
    year: "年",
    weighted: "加权",
    doneRate: "完成率",
    prevPeriod: "上一时段",
    nextPeriod: "下一时段",
    jumpCurrent: "回到当前时段",
    summaryAria: "时段总览",
    weightedCompletion: "加权完成度",
    completionAria: (v) => `完成度 ${v}%`,
    tasks: "任务",
    done: "完成",
    output: "产出",
    blocked: "卡点",
    dotOutput: (n) => `${n} 条产出`,
    dotBlocked: (n) => `${n} 个卡点`,
    vsLast: (p) => ZH_VS_LAST[p],
    newBadge: "新",
    pt: (delta) => `${delta > 0 ? "+" : ""}${delta} 分`,
    noDataLast: (p) => ZH_NO_DATA[p],
    bestDay: "最佳日",
    bestWeek: "最佳周",
    bestMonth: "最佳月",
    metricValue: (v, metric) => `${metric === "done" ? "完成率" : "加权"} ${v}%`,
    noActiveDay: "无活跃日",
    noActiveWeek: "无活跃周",
    activeDays: "活跃天数",
    tasksDone: (n, done) => `${n} 个任务 · 完成 ${done}`,
    coreFocus: "核心投入 (P1)",
    coreTasks: (n) => `${n} 个核心任务`,
    noCoreTasks: "无核心任务",
    insightsAria: (p) => `${ZH_PERIOD[p]}洞察`,
    emptyInsights: (p) => `${ZH_PERIOD[p]}暂无记录。打开任意一天添加任务，即可查看${ZH_PERIOD[p]}洞察。`,
    projectFocus: "项目投入",
    weightShareTitle: (name, pct, p) => `${name}：占${ZH_PERIOD[p]}权重 ${pct}%`,
    more: (n) => `还有 ${n} 个`,
    focusMix: "重要度分布",
    mixAria: "重要度分布",
    bandTitle: (importance, n) => `P${importance}：${n} 个任务`,
    bandTasks: (n) => `${n} 个任务`,
    weeklyOutput: "本周产出",
    monthlyOutput: "本月产出",
    blockers: "卡点记录",
    outputEmptyWeek: "本周还没有产出记录。在任务的「今日产出」里填写内容，即可生成每周回顾。",
    outputEmptyMonth: "本月还没有产出记录。在任务的「今日产出」里填写内容，即可生成每月回顾。",
    showLess: "收起",
    showAll: (n) => `展开全部 ${n} 条`,
    completionByWeek: "每周完成度",
    weeks: (n) => `${n} 周`,
    weekN: (i) => `${i}周`,
    currentStreak: "当前连续",
    longestStreak: "最长连续",
    streakDays: (n) => `${n} 天`,
    daysAtGoal: (goal) => `达标 ≥ ${goal}% 的天数`,
    inYear: (year) => `${year} 年内`,
    noRecords: "暂无记录",
    heatmapAria: (year) => `${year} 年完成度热力图`,
    completionByMonth: "每月完成度"
  },
  theme: {
    label: "主题",
    light: "浅色",
    dark: "深色",
    system: "系统"
  },
  settings: {
    title: "设置",
    signedIn: "已登录",
    recordDays: "记录天数",
    taskCount: "任务数",
    avgProgress: "平均推进",
    outputDays: "明确产出天数",
    projects: "项目数",
    pending: "待同步",
    lastSync: "上次同步",
    lastExport: "上次导出",
    never: "从未",
    appearance: "外观",
    heroAnim: "加权推进动画",
    heroFlow: "游动",
    heroShimmer: "闪烁",
    heroHint: "今日页「加权推进」的像素动画：游动让像素顺着填充方向游出并消散，闪烁则原地明暗闪烁。",
    meterStyle: "进度条样式",
    meterGlass: "液态玻璃",
    meterFlat: "极简",
    meterHint: "作用于今日页核心任务进度条、项目列表的完成度条、日历页的进度条与热力图色块：液态玻璃为 v2 经典质感，极简为纯色平面。",
    language: "语言",
    appLanguage: "界面语言",
    languageHint: "作用于整个界面。任务数据与 Excel 表头不受影响。",
    excel: "Excel",
    sync: "同步",
    syncNow: "立即同步",
    forceResync: "强制全量同步",
    forceResyncHint: "清空本机缓存并从云端重新拉取全部数据。仅在云端被清空重导后用于消除重复任务。",
    forceResyncConfirm: "强制全量同步会清空本机缓存并从云端重新拉取全部数据。仅在云端数据被清空重导、本机出现重复/残留任务时使用。继续？",
    syncError: "同步错误",
    conflicts: "冲突数",
    conflictDetails: "同步冲突详情",
    backup: "备份",
    downloadJson: "下载 JSON 备份",
    restoreJson: "从 JSON 恢复",
    restoring: "恢复中",
    backupHint: "JSON 备份包含所有项目、任务和想法的完整字段。恢复时会把文件合并进云端数据（同 ID 记录被覆盖，不会删除任何数据）。",
    restoreConfirm: (projects, tasks, nextProjects, nextIdeas) =>
      `从该文件恢复 ${projects} 个项目、${tasks} 个任务、${nextProjects} 个想法分组和 ${nextIdeas} 条想法？同 ID 记录将被覆盖。`,
    restoreDone: (projects, tasks, nextProjects, nextIdeas) =>
      `已恢复 ${projects} 个项目、${tasks} 个任务、${nextProjects} 个想法分组、${nextIdeas} 条想法。`,
    restoreInvalid: "该文件不是有效的备份 JSON。",
    restoreFailed: "恢复失败",
    backupDownloaded: "备份已下载。",
    backupFailed: "备份失败",
    security: "安全",
    changePasscode: "修改密码",
    passcodeHint: "修改登录密码（4 位数字）。修改后立即生效，旧密码——包括部署时自带的初始密码——将不再可用，其他已登录设备会被登出。",
    iphone: "iPhone",
    installNote: "在 Safari 中打开「分享」，选择「添加到主屏幕」，之后从主屏幕图标启动应用。",
    signOut: "退出登录",
    signOutPendingConfirm: (n) => `还有 ${n} 项更改未能同步，现在退出将丢失这些更改。仍要退出？`
  },
  importer: {
    pick: "导入 Excel",
    reading: "读取中",
    worksheet: "工作表",
    columnsDetected: (n) => `检测到 ${n} 列`,
    headerRow: (n) => `表头行 ${n}`,
    rowsReady: (n) => `${n} 行任务待导入`,
    confirmImport: "确认导入",
    noRows: "没有可导入的任务行。",
    importedSummary: (rows, created, updated, skipped) => `已导入 ${rows} 行：新建 ${created}，更新 ${updated}，跳过 ${skipped}。`,
    couldNotRead: "无法读取工作簿",
    emptyWorkbook: "工作簿中没有工作表。",
    importFailed: "导入失败",
    fields: {
      skip: "跳过",
      id: "ID",
      external_key: "外部键",
      project: "项目",
      title: "标题",
      status: "状态",
      priority: "优先级",
      importance: "重要程度",
      due_date: "截止日期",
      start_date: "开始日期",
      next_action: "下一步",
      notes: "备注",
      description: "描述",
      progress: "进度",
      blocker: "卡点",
      output: "产出"
    }
  },
  exporter: {
    export: "导出 Excel",
    working: "处理中",
    exportR2: "导出 + R2",
    downloaded: "已导出到本机。",
    downloadedUploaded: "已导出到本机并上传云端。",
    exportFailed: "导出失败"
  },
  login: {
    keypadAria: "密码键盘",
    welcome: "欢迎回来",
    enterPasscode: "输入 4 位数字密码",
    setTitle: "设置密码",
    choosePasscode: "设置一个 4 位数字密码",
    confirmTitle: "确认密码",
    reenterSame: "再次输入相同的密码",
    wrongPasscode: "密码错误，请重试",
    mismatch: "两次输入不一致，请重试",
    couldNotSave: "密码保存失败",
    setupToken: "初始化令牌",
    setupTokenHint: "请输入部署设置中的一次性初始化令牌",
    setupUnavailable: "请先在部署环境中配置 SETUP_TOKEN",
    clear: "清空",
    deleteKey: "删除"
  },
  passcode: {
    dialogAria: "修改密码",
    currentTitle: "修改密码",
    currentSub: "输入当前密码",
    nextTitle: "新密码",
    nextSub: "设置新的 4 位数字密码",
    confirmTitle: "确认新密码",
    confirmSub: "再次输入新密码",
    doneTitle: "密码已更新",
    doneSub: "下次登录请使用新密码",
    wrong: "当前密码错误，请重试",
    mismatch: "两次输入不一致，请重试",
    couldNotUpdate: "密码更新失败"
  }
};

export const MESSAGES: Record<Language, Messages> = { en, zh };

interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  m: Messages;
}

const I18nContext = createContext<I18nContextValue | null>(null);

let transitionToken = 0;

/**
 * Run the language swap inside a View Transition, same mechanism as the theme
 * toggle: one snapshot of the old frame morphs into the new one (the
 * lang-switching rules in app.css add a soft blur "refocus" on top of the
 * cross-fade). Falls back to an instant swap when the API is missing or
 * reduced motion is on.
 */
function swapLanguageAnimated(swap: () => void): void {
  const root = document.documentElement;
  const animatable =
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animatable) {
    swap();
    return;
  }
  // .lang-switching freezes per-element transitions beneath the snapshot and
  // scopes the blur keyframes; the token keeps a rapid re-toggle from
  // stripping the class mid-transition.
  const token = ++transitionToken;
  root.classList.add("lang-switching");
  document
    .startViewTransition(swap)
    .finished.catch(() => undefined)
    .finally(() => {
      if (token === transitionToken) root.classList.remove("lang-switching");
    });
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(getStoredLanguage);

  // Reconcile the document attributes with React state on mount and change,
  // in case the boot script and stored value drifted.
  useEffect(() => {
    applyLanguage(lang);
  }, [lang]);

  const setLang = useCallback(
    (next: Language) => {
      if (next === lang) {
        return;
      }
      swapLanguageAnimated(() => {
        // flushSync: the DOM must reach its final (translated) state inside
        // the view transition callback, or the new snapshot captures a frame
        // of the old language.
        flushSync(() => {
          setStoredLanguage(next);
          setLangState(next);
        });
      });
    },
    [lang]
  );

  const value = useMemo<I18nContextValue>(() => ({ lang, setLang, m: MESSAGES[lang] }), [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}
