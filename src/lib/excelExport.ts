import { utils, writeFileXLSX, writeXLSX } from "xlsx";
import { todayDate } from "./dates";
import {
  getExplicitTaskProgress,
  getTaskImportance,
  getTaskProgress,
  isProjectCacheTask,
  isWorklogTask,
  summarizeProgress,
  summarizeWorklogOverview,
  worklogBlocker,
  worklogOutput
} from "./progress";
import type { ExportDataResponse, Project, Task } from "./types";

const GUIDE_ROWS = [
  ["重点标记：左侧记录任务，右侧每日总结", null, null, null, null, null, null, null],
  ["日常记录里有两个区域：左侧 WorkLog 一行一个任务，右侧 Daily Summary 一天一行总结。任务明细负责记录，汇总区负责判断今天有没有推进。", null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  ["层级", "重点", "具体判断", "对应到日常记录", null, "重要程度", "权重", "含义"],
  ["核心结构", "任务明细和每日总结放在同一张表。", "WorkLog 继续一行一个任务；右侧 Daily Summary 自动把同一天任务合成一行。", "先填左侧 WorkLog，再看右侧 Daily Summary。", null, 1, 3, "今天必须推进的核心任务"],
  ["重要程度", "数字决定任务权重。", "1 是核心推进，2 是必须维护，3 是有时间再做，4 是低优先级或可延期。", "填在 WorkLog 的“重要程度”。", null, 2, 2, "必须维护的任务"],
  ["项目列", "项目是筛选和复盘的入口。", "Project A、Project B、Project C 等项目分开记录，后面才能按项目看连续推进。", "填在“项目”。", null, 3, 1, "顺手推进，有时间再做"],
  ["任务列", "任务要具体到能开始。", "不要写“推进论文”这种大块，改成“写 introduction 第一段”或“整理 figure 2 结果解释”。", "填在“任务”。", null, 4, 0.5, "低优先级或可延期"],
  ["Progress", "用真正的百分比数字表达任务推进量。", "0%、25%、50%、75%、100% 对应没开始、开始了、有推进、主要完成、完成当天目标。", "填在“Progress”，表格会显示进度条。", null, null, null, null],
  ["Daily Summary", "每天只看一行也能知道状态。", "右侧汇总区会显示核心任务进度、加权推进、有产出任务数、Blocked 数和今日判断。", "Daily Summary 在日常记录右侧自动生成。", null, "Progress", "含义", "建议"],
  ["加权推进", "避免低优先级任务把一天显得很忙。", "重要程度 1 权重最高，4 权重最低；所以核心任务没动时，整体推进不会虚高。", "看右侧 Daily Summary 的“加权推进”。", null, "0%", "没开始", "当天没有真正动这个任务"],
  ["卡点", "卡住的地方留空代表没有 blocked。", "只有真的影响继续推进时才写卡点；写了内容以后，右侧 Daily Summary 会计入 Blocked 数。", "填在 WorkLog 的“卡住的地方”。", null, "25%", "开始了，但很零散", "只做了准备、查了一点资料"],
  ["今日判断", "让表格自动告诉你今天的状态。", "如果有卡点会显示“有卡点”；核心任务进度高会显示“核心推进好”；否则看是否有产出。", "看右侧 Daily Summary 的“今日判断”。", null, "50%", "有一些推进", "已经形成一部分内容或判断"],
  ["科研动作", "很多时候，最该做的是让模糊的东西变清楚。", "把结果写成文字、把实验流程画出来、把矛盾点列成可能解释，都是有效推进。", "适合写进“任务”和“今日产出”。", null, "75%", "主要部分完成", "离当天目标只差收尾或确认"],
  ["够了标准", "一天不是所有任务都完成才算有效。", "只要至少一个重要任务留下明确产出，并且明天第一步写清楚，这一天就是推进了。", "右侧 Daily Summary 会把这一天压缩成一行。", null, "100%", "完成当天目标", "这个任务当天定义的目标已完成"],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, "Daily Summary 区域", "含义", "建议"],
  [null, null, null, null, null, "核心任务进度", "重要程度 1 的平均完成度", "看核心任务有没有推进"],
  [null, null, null, null, null, "加权推进", "按重要程度加权后的整体推进", "避免低优先级任务虚高"],
  [null, null, null, null, null, "有产出任务数", "今日产出不为空的任务数", "大于 0 说明不是空转"],
  [null, null, null, null, null, "Blocked 数", "卡住的地方不为空的任务数", "大于 0 需要处理"],
  [null, null, null, null, null, "今日判断", "自动判断当天状态", "优先显示有卡点，其次核心推进好"]
];

function projectName(projects: Project[], projectId?: string | null): string {
  return projects.find((project) => project.id === projectId)?.name ?? "";
}

function sortedWorklogTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const dateCompare = String(a.start_date ?? "").localeCompare(String(b.start_date ?? ""));
    if (dateCompare) return dateCompare;
    return getTaskImportance(a) - getTaskImportance(b) || a.sort_order - b.sort_order || a.title.localeCompare(b.title);
  });
}

function sortedProjectCacheTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const projectCompare = String(a.project_id ?? "").localeCompare(String(b.project_id ?? ""));
    if (projectCompare) return projectCompare;
    return a.sort_order - b.sort_order || a.title.localeCompare(b.title);
  });
}

function uniqueDates(tasks: Task[]): string[] {
  return [...new Set(tasks.map((task) => task.start_date).filter(Boolean) as string[])].sort();
}

function dateSpan(start: string | null, end: string | null): string[] {
  if (!start || !end) {
    return [];
  }
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00`);
  const final = new Date(`${end}T00:00:00`);
  while (!Number.isNaN(cursor.getTime()) && cursor <= final) {
    const year = cursor.getFullYear();
    const month = String(cursor.getMonth() + 1).padStart(2, "0");
    const day = String(cursor.getDate()).padStart(2, "0");
    dates.push(`${year}-${month}-${day}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function coreTaskText(tasks: Task[], projects: Project[]): string {
  return tasks
    .filter((task) => getTaskImportance(task) === 1)
    .slice(0, 4)
    .map((task) => `${projectName(projects, task.project_id)}：${task.title}`)
    .join("；");
}

function nextActionText(tasks: Task[]): string {
  return tasks
    .map((task) => task.next_action?.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join("；");
}

export function buildWorkbook(data: ExportDataResponse) {
  const workbook = utils.book_new();
  const projectsForNames = data.projects.filter((project) => !project.deleted_at);
  const projectsForExport = projectsForNames.filter((project) => project.archived === 0);
  const liveTasks = data.tasks.filter((task) => !task.deleted_at && task.archived === 0);
  const tasksForExport = sortedWorklogTasks(liveTasks.filter(isWorklogTask));
  const cacheTasks = sortedProjectCacheTasks(liveTasks.filter(isProjectCacheTask));
  const datedTasks = tasksForExport.filter((task) => task.start_date);
  const overview = summarizeWorklogOverview(tasksForExport);

  const worklogRows = [
    ["记录天数", "任务数", "平均推进", "明确产出天数", null, null, null, null, "今日日期", null, "Daily Summary", null, null, null, null, null, null, null, null, null],
    [
      overview.recordDays,
      overview.taskCount,
      overview.averageProgress / 100,
      overview.outputDays,
      null,
      null,
      null,
      null,
      todayDate(),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ],
    ["日期", "重要程度", "项目", "任务", "Progress", "今日产出", "卡住的地方", "明天第一步", "Notes", null, "日期", "当天核心任务", "核心任务进度", "加权推进", "有产出任务数", "Blocked 数", "今日判断", "明天第一步", "核心任务序号", "明天步骤序号"],
    ...tasksForExport.map((task) => {
      const explicitProgress = getExplicitTaskProgress(task);
      return [
        task.start_date ?? "",
        getTaskImportance(task),
        projectName(projectsForNames, task.project_id),
        task.title,
        explicitProgress !== null ? explicitProgress / 100 : "",
        worklogOutput(task),
        worklogBlocker(task),
        task.next_action ?? "",
        task.notes ?? "",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null
      ];
    })
  ];

  const dailyStartRow = 3;
  dateSpan(overview.firstDate, overview.lastDate).forEach((date, index) => {
    const dateTasks = datedTasks.filter((task) => task.start_date === date);
    const summary = summarizeProgress(dateTasks);
    const hasCoreTasks = dateTasks.some((task) => getTaskImportance(task) === 1);
    const rowIndex = dailyStartRow + index;
    const existing = worklogRows[rowIndex] ?? Array.from({ length: 20 }, () => null);
    existing[10] = date;
    existing[11] = coreTaskText(dateTasks, projectsForNames);
    existing[12] = hasCoreTasks ? summary.corePercent / 100 : "";
    existing[13] = dateTasks.length > 0 ? summary.weightedPercent / 100 : "";
    existing[14] = summary.outputCount;
    existing[15] = summary.blockedCount;
    existing[16] = summary.judgement;
    existing[17] = nextActionText(dateTasks);
    existing[18] = "";
    existing[19] = "";
    worklogRows[rowIndex] = existing;
  });

  const worklogSheet = utils.aoa_to_sheet(worklogRows);
  for (const address of Object.keys(worklogSheet)) {
    if (/^C2$/.test(address) || /^E\d+$/.test(address) || /^[MN]\d+$/.test(address)) {
      const cell = worklogSheet[address];
      if (cell && typeof cell === "object" && "v" in cell && typeof cell.v === "number") {
        cell.z = "0%";
      }
    }
  }
  worklogSheet["!cols"] = [
    { wch: 12 },
    { wch: 10 },
    { wch: 18 },
    { wch: 34 },
    { wch: 10 },
    { wch: 22 },
    { wch: 18 },
    { wch: 22 },
    { wch: 22 },
    { wch: 3 },
    { wch: 12 },
    { wch: 44 },
    { wch: 14 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
    { wch: 14 },
    { wch: 30 },
    { wch: 12 },
    { wch: 12 }
  ];
  utils.book_append_sheet(workbook, worklogSheet, "日常记录");

  const projectColumns = projectsForExport.map((project) => [
    project.name,
    ...cacheTasks.filter((task) => task.project_id === project.id).map((task) => task.title)
  ]);
  const maxProjectRows = Math.max(1, ...projectColumns.map((column) => column.length));
  const projectCache = Array.from({ length: maxProjectRows }, (_row, rowIndex) => projectColumns.map((column) => column[rowIndex] ?? null));
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(projectCache), "项目缓存");

  utils.book_append_sheet(workbook, utils.aoa_to_sheet(GUIDE_ROWS), "重点标记");

  return workbook;
}

export function downloadExport(data: ExportDataResponse): string {
  const workbook = buildWorkbook(data);
  const stamp = data.exportedAt.replace(/[:.]/g, "-");
  const filename = `project-manager-${stamp}.xlsx`;
  writeFileXLSX(workbook, filename);
  return filename;
}

export function workbookBlob(data: ExportDataResponse): Blob {
  const workbook = buildWorkbook(data);
  const bytes = writeXLSX(workbook, { bookType: "xlsx", type: "array" });
  return new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}
