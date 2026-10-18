// Per-frame checks for plans/001-view-swap-motion.md, in Playwright WebKit
// (the closest local stand-in for iPhone Safari; the Browser pane throttles
// rAF and freezes the animation timeline, so it can't judge motion).
//
// Read-only: service workers are blocked (or test edits leak into local D1)
// and nothing is edited; the search box is cleared again at the end.
//
// usage:
//   PM_PASSCODE=<local dev passcode> node plans/001-verify.cjs [port]
// needs the pages-dev server (see .claude/launch.json) answering on [port]
// (default 8788), and a local database with tasks on today and some
// projects (the dev data). Exit code 1 if any check fails.
const PW =
  process.env.PLAYWRIGHT_CORE ||
  "/Users/jm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core";
const { webkit } = require(PW);

const port = process.argv[2] || "8788";
const base = `http://localhost:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

async function login() {
  if (!process.env.PM_PASSCODE) throw new Error("set PM_PASSCODE to the local dev passcode");
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password: process.env.PM_PASSCODE })
  });
  if (!res.ok) throw new Error(`login ${res.status} ${await res.text()}`);
  // The session cookie is Secure, which WebKit drops on http://localhost:
  // hand it over without the flag.
  return res.headers.getSetCookie().map((c) => {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" };
  });
}

// Runs in the page: perform the `steps` ({ click, index? } | { search } |
// { wait }), then sample `targets` (name -> selector) once per frame for
// `ms`. Frame t=-1 is the state just before the steps. (No eval: the app's
// CSP forbids it, and WebKit enforces that even for test code.)
const RECORD = async ({ targets, ms, steps }) => {
  const setSearch = (value) => {
    const input = document.querySelector(".search-filters input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const read = (sel) => {
    const el = typeof sel === "string" ? document.querySelector(sel) : null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    const m = new DOMMatrixReadOnly(cs.transform === "none" ? undefined : cs.transform);
    const r = el.getBoundingClientRect();
    return {
      op: +(+cs.opacity).toFixed(3),
      tx: +m.m41.toFixed(2),
      ty: +m.m42.toFixed(2),
      translate: cs.translate,
      h: +r.height.toFixed(1),
      top: +r.top.toFixed(1),
      css: el.getAnimations().filter((a) => a.animationName).map((a) => a.animationName),
      waapi: el.getAnimations().filter((a) => !a.animationName && !(a.transitionProperty)).length
    };
  };
  const snap = () => Object.fromEntries(Object.entries(targets).map(([k, sel]) => [k, read(sel)]));
  const frames = [{ t: -1, ...snap() }];
  const t0 = performance.now();
  for (const step of steps) {
    if ("click" in step) document.querySelectorAll(step.click)[step.index ?? 0].click();
    else if ("search" in step) setSearch(step.search);
    else if ("wait" in step) await new Promise((r) => setTimeout(r, step.wait));
  }
  await new Promise((done) => {
    const loop = (t) => {
      frames.push({ t: Math.round(t - t0), ...snap() });
      if (t - t0 < ms) requestAnimationFrame(loop);
      else done();
    };
    requestAnimationFrame(loop);
  });
  return frames;
};

const NAV_ITEMS = ".bottom-nav a, .bottom-nav button";
const clickNav = (index) => ({ click: NAV_ITEMS, index });
const search = (value) => ({ search: value });
// One-off actions outside a recording.
const run = (page, steps) => page.evaluate(RECORD, { targets: {}, ms: 0, steps });
const NAV = { today: 0, projects: 1, search: 4 };
const ROWS = ".task-table > .task-table-row";

async function open(browser, reducedMotion) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "block",
    reducedMotion
  });
  await ctx.addCookies(await login());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(base + "/");
  await page.waitForSelector(".page-content", { timeout: 15000 });
  return { ctx, page };
}

(async () => {
  const browser = await webkit.launch();

  // ---- launch: page blocks carry no entrance of their own -------------------
  {
    const { ctx, page } = await open(browser, "no-preference");
    await page.waitForSelector(".task-table-wrap");
    const names = await page.evaluate(() =>
      [".task-table-wrap", ".progress-summary"].flatMap((sel) =>
        (document.querySelector(sel)?.getAnimations() ?? []).filter((a) => a.animationName).map((a) => `${sel}:${a.animationName}`)
      )
    );
    check("launch: list and summary don't run their own fade-up", !names.some((n) => n.endsWith(":fade-up")), names.join(", ") || "none");
    // Wait out the one-time first-reveal timer before switching anything.
    await wait(2000);

    // ---- day switch: one sheet, one clock --------------------------------------
    const [prevSel, nextSel] = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll(".today-page-header button")).map((b) => b.getAttribute("aria-label"));
      const sel = (l) => `.today-page-header button[aria-label=${JSON.stringify(l)}]`;
      return [sel(labels[0]), sel(labels[labels.length - 1])];
    });
    const targets = { body: ".page-body", table: ".task-table-wrap" };
    let frames = await page.evaluate(RECORD, { targets, ms: 400, steps: [{ click: nextSel }] });
    const after = frames.filter((f) => f.t >= 0);
    const tableAlone = after.filter((f) => f.table && (f.table.op < 1 || f.table.css.includes("fade-up") || Math.abs(f.table.ty) > 0.01));
    check(
      "day switch: the list rides the body's slide (no fade/rise of its own)",
      tableAlone.length === 0,
      tableAlone.length ? `first offending frame t=${tableAlone[0].t}: op ${tableAlone[0].table.op}, ty ${tableAlone[0].table.ty}, css [${tableAlone[0].table.css}]` : ""
    );
    check("day switch forward: the body comes in from the right", after[0]?.body?.tx > 0, `first frame tx ${after[0]?.body?.tx}`);
    const settledBy = after.find((f) => f.body && f.body.op === 1 && Math.abs(f.body.tx) < 0.05)?.t;
    check("day switch: everything lands within ~200ms", settledBy !== undefined && settledBy <= 220, `settled at ${settledBy}ms`);

    await wait(400);
    // Two days ahead, then back home through the Today tab: going back in
    // time must come in from the left, whichever button was pressed last.
    await run(page, [{ click: nextSel }]);
    await wait(400);
    frames = await page.evaluate(RECORD, { targets, ms: 120, steps: [clickNav(NAV.today)] });
    const home = frames.find((f) => f.t >= 0);
    check("Today tab from a later day: the body comes in from the left", home?.body?.tx < 0, `first frame tx ${home?.body?.tx}`);
    await wait(400);
    await run(page, [{ click: prevSel }]);
    await wait(400);
    await run(page, [clickNav(NAV.today)]);
    await wait(400);

    // ---- search: typing filters in place -----------------------------------
    await run(page, [clickNav(NAV.search)]);
    await wait(1200);
    // Find a character that keeps the first row and drops the second.
    const probe = await page.evaluate(async ({ rows }) => {
      const setSearch = (value) => {
        const input = document.querySelector(".search-filters input");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const list = Array.from(document.querySelectorAll(rows));
      if (list.length < 3) return null;
      const first = list[0].dataset.motionKey;
      const second = list[1].dataset.motionKey;
      const title = (list[0].querySelector(".task-summary__title")?.textContent || list[0].textContent || "").toLowerCase();
      for (const ch of Array.from(new Set(title.replace(/\s/g, "")))) {
        setSearch(ch);
        await frame();
        const keep = document.querySelector(`[data-motion-key="${first}"]`);
        const gone = document.querySelector(`[data-motion-key="${second}"]`);
        const ok = keep && !keep.classList.contains("is-exiting") && (!gone || gone.classList.contains("is-exiting"));
        setSearch("");
        await new Promise((r) => setTimeout(r, 700));
        if (ok) return { ch, first, second };
      }
      return null;
    }, { rows: ROWS });
    if (!probe) {
      check("search: found a character that keeps row 1 and drops row 2", false, "no such character in the first row's title");
    } else {
      const sTargets = { table: ".task-table-wrap", keep: `[data-motion-key="${probe.first}"]`, gone: `[data-motion-key="${probe.second}"]` };
      frames = await page.evaluate(RECORD, { targets: sTargets, ms: 450, steps: [search(probe.ch)] });
      const typed = frames.filter((f) => f.t >= 0);
      const blink = typed.filter((f) => f.table && (f.table.op < 1 || f.table.css.includes("fade-up")));
      check("search keystroke: the result list never blinks or re-enters", blink.length === 0, blink.length ? `t=${blink[0].t} op ${blink[0].table.op} css [${blink[0].table.css}]` : "");
      const keepMoved = typed.filter((f) => f.keep && f.keep.op < 1);
      check("search keystroke: a row that still matches stays fully visible", keepMoved.length === 0, keepMoved.length ? `t=${keepMoved[0].t} op ${keepMoved[0].keep.op}` : "");
      const goneAt = typed.find((f) => !f.gone)?.t;
      check("search keystroke: a dropped row folds out within ~260ms", goneAt !== undefined && goneAt <= 300 && typed.some((f) => f.gone && f.gone.h > 0 && f.t > 0), `unmounted at ${goneAt}ms`);
      await run(page, [search("")]);
      await wait(800);

      // Backspace mid-fold: the row grows back from where it was.
      const full = await page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().height, sTargets.gone);
      frames = await page.evaluate(RECORD, {
        targets: sTargets,
        ms: 450,
        steps: [search(probe.ch), { wait: 100 }, search("")]
      });
      const back = frames.find((f) => f.t >= 0 && f.gone);
      check(
        "search backspace mid-fold: the row reopens from its folded height (no snap)",
        back && back.gone.h < full * 0.6,
        back ? `first frame after return: ${back.gone.h}px of ${full.toFixed(1)}px` : "row missing"
      );
      await wait(800);

      // A query that matches nothing folds the whole table; taking it back
      // reopens the table from where it got to.
      const tableFull = await page.evaluate(() => document.querySelector(".task-table").getBoundingClientRect().height);
      frames = await page.evaluate(RECORD, {
        targets: { tbl: ".task-table" },
        ms: 300,
        steps: [search("☃☃☃"), { wait: 100 }, search("")]
      });
      const tb = frames.find((f) => f.t >= 0 && f.tbl);
      check(
        "search no-match then backspace: the table reopens (no snap)",
        tb && tb.tbl.h < tableFull * 0.9,
        tb ? `first frame after return: ${tb.tbl.h}px of ${tableFull.toFixed(1)}px` : "table missing"
      );
      await run(page, [search("")]);
      await wait(800);
    }

    // ---- project switch: rows settle like a tab switch ------------------------
    await run(page, [clickNav(NAV.projects)]);
    await wait(1200);
    const hasOther = await page.evaluate(() => Boolean(document.querySelector(".project-row:not(.active)")));
    if (!hasOther) {
      check("project switch: there is another project to switch to", false, "only one project row");
    } else {
      // Step away to another project, then film the switch back to the first
      // row ("All projects"), which is sure to have tasks to land.
      await run(page, [{ click: ".project-row:not(.active)" }]);
      await wait(800);
      frames = await page.evaluate(RECORD, {
        targets: { table: ".task-table-wrap", row: ROWS },
        ms: 400,
        steps: [{ click: ".project-row" }]
      });
      const sw = frames.filter((f) => f.t >= 0);
      check("project switch: the list doesn't run its own fade-up", !sw.some((f) => f.table && f.table.css.includes("fade-up")));
      const landing = sw.find((f) => f.row);
      if (landing && landing.row.top >= 852) {
        // Only on-screen blocks settle; a first row below the fold proves nothing.
        console.log(`SKIP  project switch: the first row lands — it starts off screen (top ${landing.row.top}px)`);
      } else {
        check(
          "project switch: the first row lands (opacity < 1, 10px → 0) like a tab switch",
          Boolean(landing && landing.row.op < 1 && landing.row.translate !== "none"),
          landing ? `first frame op ${landing.row.op} translate ${landing.row.translate} top ${landing.row.top}` : "no rows in that project"
        );
      }
    }
    await ctx.close();
  }

  // ---- reduced motion: swaps are instant ------------------------------------
  {
    const { ctx, page } = await open(browser, "reduce");
    await wait(2000);
    const nextSel = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll(".today-page-header button")).map((b) => b.getAttribute("aria-label"));
      return `.today-page-header button[aria-label=${JSON.stringify(labels[labels.length - 1])}]`;
    });
    const frames = await page.evaluate(RECORD, { targets: { body: ".page-body", table: ".task-table-wrap" }, ms: 120, steps: [{ click: nextSel }] });
    const moved = frames.filter((f) => f.t >= 0 && ((f.body && (f.body.op < 1 || f.body.tx !== 0)) || (f.table && f.table.op < 1)));
    check("reduced motion: the day switch is instant", moved.length === 0, moved.length ? `t=${moved[0].t}` : "");
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
