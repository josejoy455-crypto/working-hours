/* =========================================================
   LEDGER — Salary & Overtime Calculator
   Vanilla JS, LocalStorage-backed, offline-first
   ========================================================= */

(() => {
"use strict";

/* ---------- Constants & Storage Keys ---------- */
const LS_CONFIG = "ledger_config_v1";
const LS_ENTRIES = "ledger_entries_v1";
const LS_THEME = "ledger_theme_v1";

const DEFAULT_CONFIG = {
  monthlySalary: 30000,
  otRate: 150,
  workStart: "09:00",
  workEnd: "17:00",
  maxOTHoursPerDay: 4,
  paidLeavesPerMonth: 1,
  weeklyOffDays: [0] // 0=Sunday ... 6=Saturday. Days in this list are non-working; any hours worked count fully as OT.
};

// Daily salary is monthly salary divided by however many calendar days are in that specific
// month (31 in July, 30 in June, 28/29 in Feb) — so daily amounts always sum back to exactly
// the monthly salary with no leftover or overshoot.
function dailySalary(year, monthIdx) {
  let y = year, m = monthIdx;
  if (y === undefined || m === undefined) {
    const now = new Date();
    y = now.getFullYear();
    m = now.getMonth();
  }
  const days = daysInMonth(y, m);
  return days > 0 ? config.monthlySalary / days : 0;
}

/* ---------- State ---------- */
let config = loadConfig();
let entries = loadEntries(); // { "YYYY-MM-DD": { status, clockIn, clockOut, notes } }  status: worked | leave | paid-leave
let calViewDate = new Date(); // month currently shown in calendar
let activeReportType = "daily";
let activeHistoryType = "salary";
let editingDateKey = null;

/* ---------- Utilities ---------- */
function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function fmtMoney(n) {
  if (isNaN(n)) n = 0;
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  return sign + "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}
function fmtMoneyDec(n) {
  if (isNaN(n)) n = 0;
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  return sign + "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutesToHM(mins) {
  mins = Math.max(0, Math.round(mins));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2,"0")}m`;
}
function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}
function daysInMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0).getDate();
}
function monthName(year, monthIdx) {
  return new Date(year, monthIdx, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}
function isSameMonth(dateKey, year, monthIdx) {
  const [y, m] = dateKey.split("-").map(Number);
  return y === year && (m - 1) === monthIdx;
}

/* ---------- Storage ---------- */
function loadConfig() {
  try {
    const raw = localStorage.getItem(LS_CONFIG);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {}
  return { ...DEFAULT_CONFIG };
}
function saveConfig() {
  localStorage.setItem(LS_CONFIG, JSON.stringify(config));
}
function loadEntries() {
  try {
    const raw = localStorage.getItem(LS_ENTRIES);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {};
}
function saveEntries() {
  localStorage.setItem(LS_ENTRIES, JSON.stringify(entries));
}

/* ---------- Core Calculation Engine ---------- */
// True if the given date key falls on a configured weekly off day (e.g. Sunday)
function isWeeklyOff(dateKey) {
  if (!dateKey) return false;
  const d = new Date(dateKey + "T00:00:00");
  return (config.weeklyOffDays || []).includes(d.getDay());
}

// Compute worked/OT minutes for one entry.
// - Paid leave: no hours worked (day is paid via dailySalary elsewhere), no OT possible.
// - Unpaid leave: no hours, no pay for that day (simply not earned — no extra penalty).
// - OT-only (e.g. Sunday with no regular shift): a direct OT-hours number, no normal hours.
// - Weekly off day (e.g. Sunday) worked via clock in/out: the ENTIRE session counts as overtime.
// - Normal working day: the normal window floats to start at clock-in and run for the
//   configured shift duration; anything after that counts as overtime.
function computeEntryMinutes(entry, dateKey) {
  if (!entry) return { normalMin: 0, otMin: 0, totalMin: 0 };
  if (entry.status === "leave" || entry.status === "paid-leave") {
    return { normalMin: 0, otMin: 0, totalMin: 0 };
  }
  if (entry.status === "ot-only") {
    const otMin = Math.max(0, Math.round((entry.otOnlyHours || 0) * 60));
    return { normalMin: 0, otMin, totalMin: otMin };
  }
  if (!entry.clockIn || !entry.clockOut) {
    return { normalMin: 0, otMin: 0, totalMin: 0 };
  }
  const inMin = timeToMinutes(entry.clockIn);
  let outMin = timeToMinutes(entry.clockOut);
  if (outMin <= inMin) outMin += 24 * 60; // handle overnight shifts
  const totalMin = outMin - inMin;

  // Weekly off day (e.g. Sunday) worked as full overtime
  if (isWeeklyOff(dateKey)) {
    return { normalMin: 0, otMin: totalMin, totalMin };
  }

  // Floating normal window: starts at actual clock-in, runs for the configured shift length
  const shiftLen = shiftDurationMinutes();
  const normalWindowEnd = inMin + shiftLen;

  const normalMin = Math.min(totalMin, shiftLen);
  const otMin = Math.max(0, outMin - normalWindowEnd);

  return { normalMin, otMin, totalMin };
}

function hourlySalary(year, monthIdx) {
  const shiftMinutes = shiftDurationMinutes();
  const shiftHours = shiftMinutes / 60;
  return shiftHours > 0 ? dailySalary(year, monthIdx) / shiftHours : 0;
}
function shiftDurationMinutes() {
  const s = timeToMinutes(config.workStart);
  let e = timeToMinutes(config.workEnd);
  if (e <= s) e += 24 * 60;
  return e - s;
}
function maxOTMinutesPerDay() {
  return Math.max(0, (config.maxOTHoursPerDay || 0) * 60);
}

// Get all entry keys within current month (based on "today")
function monthEntries(year, monthIdx) {
  return Object.keys(entries)
    .filter(k => isSameMonth(k, year, monthIdx))
    .sort();
}

function computeMonthStats(year, monthIdx) {
  const keys = monthEntries(year, monthIdx);
  const now = new Date();
  const isCurrentMonth = (now.getFullYear() === year && now.getMonth() === monthIdx);
  const todayNum = now.getDate();
  const totalDaysInMonth = daysInMonth(year, monthIdx);

  // Count workable days (calendar days minus configured weekly-off days like Sunday) — used
  // purely as a work-log progress indicator, separate from earnings.
  // Also count ALL remaining calendar days from today onward (including weekly-off days), since
  // overtime can be earned on any day, including Sundays.
  let workableDaysTotal = 0, workableDaysPast = 0;
  let daysRemainingFromToday = 0;
  for (let d = 1; d <= totalDaysInMonth; d++) {
    const key = `${year}-${String(monthIdx+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    if (!isWeeklyOff(key)) {
      workableDaysTotal++;
      if (isCurrentMonth && d < todayNum) workableDaysPast++;
    }
    if (!isCurrentMonth || d >= todayNum) daysRemainingFromToday++;
  }

  let normalMinTotal = 0, otMinTotal = 0, leaveCount = 0, paidLeaveCount = 0, workedDays = 0;
  let normalMinToDate = 0, otMinToDate = 0, leaveCountToDate = 0, paidLeaveCountToDate = 0, workedDaysToDate = 0;
  let baseSalaryEarned = 0; // flat daily-salary credit accumulated from logged entries (paid-leave, off-day-worked, ot-only, and normal weekday pay)

  const dSalary = dailySalary(year, monthIdx);
  const hSalary = hourlySalary(year, monthIdx);

  keys.forEach(k => {
    const day = Number(k.split("-")[2]);
    const entry = entries[k];
    const inToDate = !isCurrentMonth || day <= todayNum;
    if (!inToDate) return; // only accumulate earnings for days that have occurred

    if (entry.status === "leave") {
      leaveCount++;
      leaveCountToDate++;
      return;
    }
    if (entry.status === "paid-leave") {
      paidLeaveCount++;
      paidLeaveCountToDate++;
      baseSalaryEarned += dSalary;
      return;
    }

    const { normalMin, otMin } = computeEntryMinutes(entry, k);
    if (normalMin > 0 || otMin > 0) { workedDays++; workedDaysToDate++; }
    normalMinTotal += normalMin;
    otMinTotal += otMin;
    normalMinToDate += normalMin;
    otMinToDate += otMin;

    if (entry.status === "ot-only" || (entry.status === "worked" && isWeeklyOff(k))) {
      // Off-day worked or OT-only: fixed monthly salary already covers this day — credit the
      // flat daily salary here; OT pay is accounted for separately below via otMinToDate.
      baseSalaryEarned += dSalary;
    } else {
      // Normal weekday worked entry: pay follows actual hours within the shift window.
      baseSalaryEarned += (normalMin / 60) * hSalary;
    }
  });

  const otPay = (otMinToDate / 60) * config.otRate;
  const paidLeaveSalary = paidLeaveCountToDate * dSalary;
  // Unpaid leave simply means that day's daily salary is never added — it is NOT an extra
  // penalty subtracted from earnings. We still report the lost potential for information.
  const leaveLostPotential = leaveCountToDate * dSalary;

  const normalSalaryEarned = baseSalaryEarned - paidLeaveSalary; // non-paid-leave portion, for summary display
  const currentSalaryEarned = baseSalaryEarned + otPay;

  // Expected salary: fixed daily salary rate applied across every calendar day elapsed so far
  // (assuming no leave), since the monthly salary accrues automatically per day.
  const daysElapsedSoFar = isCurrentMonth ? todayNum : totalDaysInMonth;
  const expectedSalary = daysElapsedSoFar * dSalary;

  // Maximum possible salary this month = fixed monthly salary + OT already earned + the
  // best-case OT still achievable across ALL remaining calendar days (including Sundays/off
  // days, since overtime can be earned on any day).
  const maxOTMin = maxOTMinutesPerDay();
  const maxOTPayRemaining = daysRemainingFromToday * (maxOTMin / 60) * config.otRate;
  const maxPossibleSalary = config.monthlySalary + otPay + maxOTPayRemaining;
  const maxOTPay = otPay + maxOTPayRemaining; // total OT potential: already earned + still achievable

  const totalMonthlySalaryBase = config.monthlySalary;
  // Remaining to earn = (basic salary + OT earned + OT still achievable) − what's been earned so far
  const remaining = Math.max(0, maxPossibleSalary - currentSalaryEarned);

  const paidLeavesRemaining = Math.max(0, (config.paidLeavesPerMonth || 0) - paidLeaveCountToDate);

  return {
    normalMinTotal, otMinTotal, leaveCount, paidLeaveCount, workedDays,
    normalMinToDate, otMinToDate, leaveCountToDate, paidLeaveCountToDate, workedDaysToDate,
    normalSalaryEarned, otPay, leaveLostPotential, paidLeaveSalary, currentSalaryEarned,
    expectedSalary, maxPossibleSalary, maxOTPay, totalMonthlySalaryBase, remaining,
    dSalary, hSalary, paidLeavesRemaining,
    workableDaysTotal, daysRemainingFromToday,
    workingDaysRemaining: Math.max(0, workableDaysTotal - workedDaysToDate)
  };
}

// Unified day-pay calculator used across dashboard, tracker, calendar, and reports.
// Computes pay for a single logged entry.
// - Unpaid leave: 0 — that day's salary simply isn't earned, no extra penalty.
// - Paid leave: flat daily salary, no OT.
// - OT-only entries (e.g. Sunday with no regular shift) and days worked on a weekly-off day
//   (e.g. clocking in on a Sunday): since the monthly salary is fixed and already covers every
//   calendar day except unpaid leave, these days still earn the flat daily salary — PLUS
//   whatever overtime was actually worked that day, on top.
// - Normal weekday "worked" entries: unchanged — pay follows actual hours within the shift
//   window (capped at a full day's pay), plus any overtime beyond the shift.
function dayPay(k) {
  const e = entries[k];
  if (!e) return 0;
  if (e.status === "leave") return 0; // unpaid leave: simply not earned, no penalty
  const [y, m] = k.split("-").map(Number);
  const dSalary = dailySalary(y, m - 1);
  if (e.status === "paid-leave") return dSalary;

  const { normalMin, otMin } = computeEntryMinutes(e, k);
  const otPay = (otMin / 60) * config.otRate;

  if (e.status === "ot-only" || (e.status === "worked" && isWeeklyOff(k))) {
    return dSalary + otPay;
  }

  const hS = hourlySalary(y, m - 1);
  return (normalMin / 60) * hS + otPay;
}

/* ---------- DOM refs ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const heroDate = $("#heroDate");
const heroTime = $("#heroTime");
const clockBtn = $("#clockBtn");
const clockInDisplay = $("#clockInDisplay");
const clockOutDisplay = $("#clockOutDisplay");
const hoursTodayDisplay = $("#hoursTodayDisplay");
const editShiftBtn = $("#editShiftBtn");

/* ---------- Clock / live time ---------- */
function tickClock() {
  const now = new Date();
  heroDate.textContent = now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  heroTime.textContent = now.toLocaleTimeString("en-IN", { hour12: false });
}
tickClock();
setInterval(tickClock, 1000);

/* ---------- Today ticket / clock in-out ---------- */
function refreshTicket() {
  const key = todayKey();
  const entry = entries[key];
  if (entry && entry.clockIn) {
    clockInDisplay.textContent = entry.clockIn;
  } else {
    clockInDisplay.textContent = "— : —";
  }
  if (entry && entry.clockOut) {
    clockOutDisplay.textContent = entry.clockOut;
  } else {
    clockOutDisplay.textContent = "— : —";
  }

  if (entry && entry.status !== "leave" && entry.status !== "paid-leave") {
    const { totalMin } = computeEntryMinutes(entry, key);
    hoursTodayDisplay.textContent = entry.clockIn && entry.clockOut ? minutesToHM(totalMin) : "0h 00m";
  } else {
    hoursTodayDisplay.textContent = "0h 00m";
  }

  if (entry && entry.clockIn && !entry.clockOut) {
    clockBtn.textContent = "Clock Out";
    clockBtn.classList.add("is-out");
  } else {
    clockBtn.textContent = "Clock In";
    clockBtn.classList.remove("is-out");
  }
}

clockBtn.addEventListener("click", () => {
  const key = todayKey();
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  if (!entries[key]) entries[key] = { status: "worked", clockIn: null, clockOut: null, notes: "" };
  const entry = entries[key];

  if (!entry.clockIn || (entry.clockIn && entry.clockOut)) {
    // start a new clock-in
    entry.clockIn = timeStr;
    entry.clockOut = null;
    entry.status = "worked";
    showToast(isWeeklyOff(key) ? "Clocked in " + timeStr + " · off-day, counts as OT" : "Clocked in at " + timeStr);
  } else {
    entry.clockOut = timeStr;
    showToast("Clocked out at " + timeStr);
  }
  saveEntries();
  refreshAll();
});

editShiftBtn.addEventListener("click", () => openEntryModal(todayKey()));

/* ---------- Tabs ---------- */
$$(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    $$(".panel").forEach(p => p.classList.remove("active"));
    $("#panel-" + tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "calendar") renderCalendar();
    if (tab.dataset.tab === "reports") renderReports();
    if (tab.dataset.tab === "tracker") renderEntryList();
  });
});

/* ---------- Theme ---------- */
function applyTheme(theme) {
  document.body.dataset.theme = theme;
  $(".icon-sun").style.display = theme === "dark" ? "block" : "none";
  $(".icon-moon").style.display = theme === "light" ? "block" : "none";
  localStorage.setItem(LS_THEME, theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#14181F" : "#F7F4EC");
}
$("#themeToggle").addEventListener("click", () => {
  const cur = document.body.dataset.theme;
  applyTheme(cur === "dark" ? "light" : "dark");
});
(function initTheme() {
  const saved = localStorage.getItem(LS_THEME);
  if (saved) applyTheme(saved);
  else {
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(prefersLight ? "light" : "dark");
  }
})();

$("#settingsToggle").addEventListener("click", () => {
  $$(".tab").forEach(t => t.classList.remove("active"));
  $('.tab[data-tab="settings"]').classList.add("active");
  $$(".panel").forEach(p => p.classList.remove("active"));
  $("#panel-settings").classList.add("active");
});

/* ---------- Dashboard rendering ---------- */
function renderDashboard() {
  const now = new Date();
  const year = now.getFullYear(), monthIdx = now.getMonth();
  const stats = computeMonthStats(year, monthIdx);

  $("#monthLabel").textContent = monthName(year, monthIdx);

  // progress
  const pct = stats.workableDaysTotal > 0 ? Math.min(100, (stats.workedDaysToDate / stats.workableDaysTotal) * 100) : 0;
  $("#progressFill").style.width = pct + "%";
  $("#progressMarker").style.left = pct + "%";
  $("#progressLabel").textContent = `${stats.workedDaysToDate} / ${stats.workableDaysTotal}`;

  // today
  const todayKeyStr = todayKey();
  const todayEntry = entries[todayKeyStr];
  const todayCalc = computeEntryMinutes(todayEntry, todayKeyStr);
  const todayOTPay = (todayCalc.otMin / 60) * config.otRate;
  let todayEarnings = 0;
  if (todayEntry) {
    if (todayEntry.status === "paid-leave") {
      todayEarnings = stats.dSalary;
    } else if (todayEntry.status === "ot-only" || (todayEntry.status === "worked" && isWeeklyOff(todayKeyStr))) {
      todayEarnings = stats.dSalary; // OT shown separately below
    } else if (todayEntry.status === "worked") {
      todayEarnings = (todayCalc.normalMin / 60) * stats.hSalary;
    }
  }

  $("#statCurrentSalary").textContent = fmtMoney(stats.currentSalaryEarned);
  $("#statTodayEarnings").textContent = fmtMoney(todayEarnings);
  $("#statTodayOT").textContent = fmtMoney(todayOTPay);
  $("#statTodayOTHours").textContent = minutesToHM(todayCalc.otMin);
  $("#statTotalOTPay").textContent = fmtMoney(stats.otPay);
  $("#statTotalOTHours").textContent = minutesToHM(stats.otMinToDate) + " total";
  $("#statLeaveDeduction").textContent = fmtMoney(stats.leaveLostPotential);
  $("#statLeaveCount").textContent = `${stats.leaveCountToDate} unpaid`;
  $("#statRemaining").textContent = fmtMoney(stats.remaining);
  if ($("#statPaidLeave")) {
    $("#statPaidLeave").textContent = `${stats.paidLeaveCountToDate} / ${config.paidLeavesPerMonth || 0}`;
    $("#statPaidLeaveFoot").textContent = stats.paidLeavesRemaining > 0 ? `${stats.paidLeavesRemaining} remaining` : "none remaining";
  }

  // summary table
  $("#sumDaily").textContent = fmtMoneyDec(stats.dSalary);
  $("#sumHourly").textContent = fmtMoneyDec(stats.hSalary);
  $("#sumNormal").textContent = fmtMoney(stats.normalSalaryEarned);
  $("#sumOTHours").textContent = minutesToHM(stats.otMinToDate);
  $("#sumOTPay").textContent = fmtMoney(stats.otPay);
  $("#sumLeaveDeduction").textContent = fmtMoney(stats.leaveLostPotential);
  if ($("#sumPaidLeave")) $("#sumPaidLeave").textContent = fmtMoney(stats.paidLeaveSalary);
  $("#sumCurrent").textContent = fmtMoney(stats.currentSalaryEarned);
  $("#sumExpected").textContent = fmtMoney(stats.expectedSalary);
  $("#sumMaxOT").textContent = fmtMoney(stats.maxOTPay);
  $("#sumMax").textContent = fmtMoney(stats.maxPossibleSalary);
  $("#sumTotal").textContent = fmtMoney(stats.totalMonthlySalaryBase);
  $("#sumDaysDone").textContent = stats.workedDaysToDate;
  $("#sumDaysLeft").textContent = stats.workingDaysRemaining;
}

/* ---------- Shift Tracker list ---------- */
function renderEntryList() {
  const list = $("#entryList");
  const keys = Object.keys(entries).sort().reverse().slice(0, 60);
  if (keys.length === 0) {
    list.innerHTML = `<div class="empty-state">No entries yet. Clock in or add a manual entry to get started.</div>`;
    return;
  }
  list.innerHTML = keys.map(k => {
    const e = entries[k];
    const d = new Date(k + "T00:00:00");
    const dnum = d.getDate();
    const dmon = d.toLocaleDateString("en-IN", { month: "short" });
    const dwk = d.toLocaleDateString("en-IN", { weekday: "short" });
    let timesStr = "—", badges = "";
    const amount = dayPay(k);
    if (e.status === "leave") {
      badges += `<span class="badge badge-leave">Unpaid Leave</span>`;
    } else if (e.status === "paid-leave") {
      badges += `<span class="badge badge-paid">Paid Leave</span>`;
    } else if (e.status === "ot-only") {
      const { otMin } = computeEntryMinutes(e, k);
      timesStr = "No regular shift";
      badges += `<span class="badge badge-ot">OT only · ${minutesToHM(otMin)}</span>`;
    } else {
      const { otMin } = computeEntryMinutes(e, k);
      timesStr = (e.clockIn && e.clockOut) ? `${e.clockIn} → ${e.clockOut}` : (e.clockIn ? `${e.clockIn} → …` : "No times set");
      const suspiciousMidnight = e.clockOut === "00:00" && e.clockIn !== "00:00";
      if (suspiciousMidnight) badges += `<span class="badge badge-leave">⚠ check Clock Out</span>`;
      if (isWeeklyOff(k) && otMin > 0) badges += `<span class="badge badge-ot">Off-day OT ${minutesToHM(otMin)}</span>`;
      else if (otMin > 0) badges += `<span class="badge badge-ot">OT ${minutesToHM(otMin)}</span>`;
    }
    if (e.notes) badges += `<span class="badge badge-note">📝 note</span>`;
    return `
      <div class="entry-item" data-key="${k}">
        <div class="entry-date"><span class="dnum">${dnum}</span><span class="dmon">${dmon}</span><span class="dwk">${dwk}</span></div>
        <div class="entry-body">
          <div class="entry-top">
            <span class="entry-times">${timesStr}</span>
          </div>
          <div class="entry-badges">${badges}</div>
        </div>
        <div class="entry-amount">${fmtMoney(amount)}</div>
      </div>`;
  }).join("");

  list.querySelectorAll(".entry-item").forEach(el => {
    el.addEventListener("click", () => openEntryModal(el.dataset.key));
  });
}

$("#addManualEntry").addEventListener("click", () => openEntryModal(todayKey()));

/* ---------- Modal (manual entry) ---------- */
const modalOverlay = $("#modalOverlay");
const entryForm = $("#entryForm");
const entryStatus = $("#entryStatus");
const entryTimeRow = $("#entryTimeRow");

function openEntryModal(dateKey) {
  editingDateKey = dateKey;
  const isNew = !entries[dateKey];
  const e = entries[dateKey] || { status: "worked", clockIn: config.workStart, clockOut: "", notes: "" };
  $("#entryDate").value = dateKey;
  entryStatus.value = e.status || "worked";
  $("#entryClockIn").value = e.clockIn || (isNew ? config.workStart : "");
  // Clock Out is intentionally left blank for a brand-new/incomplete entry — pre-filling it
  // risks the native time picker silently treating an untouched field as a real "00:00" value.
  $("#entryClockOut").value = e.clockOut || "";
  $("#entryNotes").value = e.notes || "";
  $("#entryOTOnlyHours").value = e.otOnlyHours ?? "";
  toggleEntryTimeRow();
  $("#modalTitle").textContent = entries[dateKey] ? "Edit Entry" : "Add Entry";
  $("#deleteEntryBtn").style.display = entries[dateKey] ? "inline-block" : "none";
  modalOverlay.classList.add("open");
}
function closeModal() { modalOverlay.classList.remove("open"); editingDateKey = null; }
$("#modalClose").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });

function toggleEntryTimeRow() {
  const status = entryStatus.value;
  entryTimeRow.style.display = (status === "worked") ? "flex" : "none";
  $("#entryOTOnlyRow").style.display = (status === "ot-only") ? "flex" : "none";
}
entryStatus.addEventListener("change", toggleEntryTimeRow);

entryForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const dateVal = $("#entryDate").value;
  if (!dateVal) return;
  const status = entryStatus.value;
  const clockIn = status === "worked" ? ($("#entryClockIn").value || null) : null;
  const clockOut = status === "worked" ? ($("#entryClockOut").value || null) : null;
  const otOnlyHours = status === "ot-only" ? Number($("#entryOTOnlyHours").value || 0) : null;
  const notes = $("#entryNotes").value.trim();

  // Guard against the native time picker silently saving midnight when the field was never
  // deliberately set — 00:00 is an implausible clock-out for almost any real shift.
  if (status === "worked" && clockIn && clockOut === "00:00" && clockIn !== "00:00") {
    const confirmMidnight = confirm("Clock Out is set to 00:00 (midnight). Is that really correct? Tap Cancel to leave it blank instead.");
    if (!confirmMidnight) {
      showToast("Entry not saved — set a real Clock Out time");
      return;
    }
  }

  if (status === "worked" && clockIn && clockOut) {
    const inM = timeToMinutes(clockIn);
    let outM = timeToMinutes(clockOut);
    if (outM <= inM) outM += 24*60;
    if (outM - inM > 20*60) {
      showToast("⚠ Shift longer than 20 hours — check times");
    }
  }
  if (status === "ot-only" && (!otOnlyHours || otOnlyHours <= 0)) {
    showToast("⚠ Enter overtime hours worked");
    return;
  }

  if (status === "paid-leave") {
    const d = new Date(dateVal + "T00:00:00");
    const stats = computeMonthStats(d.getFullYear(), d.getMonth());
    const alreadyPaidLeaveHere = entries[dateVal] && entries[dateVal].status === "paid-leave";
    if (!alreadyPaidLeaveHere && stats.paidLeaveCount >= (config.paidLeavesPerMonth || 0)) {
      showToast(`⚠ Paid leave quota (${config.paidLeavesPerMonth}/month) already used`);
    }
  }

  entries[dateVal] = { status, clockIn, clockOut, otOnlyHours, notes };
  saveEntries();
  closeModal();
  showToast("Entry saved");
  refreshAll();
});

$("#deleteEntryBtn").addEventListener("click", () => {
  if (editingDateKey && entries[editingDateKey]) {
    delete entries[editingDateKey];
    saveEntries();
    closeModal();
    showToast("Entry deleted");
    refreshAll();
  }
});

/* ---------- Calendar ---------- */
function renderCalendar() {
  const year = calViewDate.getFullYear();
  const monthIdx = calViewDate.getMonth();
  $("#calMonthLabel").textContent = monthName(year, monthIdx);

  const grid = $("#calGrid");
  const dows = ["S","M","T","W","T","F","S"];
  let html = dows.map(d => `<div class="cal-dow">${d}</div>`).join("");

  const firstDay = new Date(year, monthIdx, 1).getDay();
  const totalDays = daysInMonth(year, monthIdx);
  const todayStr = todayKey();

  for (let i = 0; i < firstDay; i++) html += `<div class="cal-cell empty"></div>`;

  for (let d = 1; d <= totalDays; d++) {
    const key = `${year}-${String(monthIdx+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const e = entries[key];
    const off = isWeeklyOff(key);
    let dots = "";
    if (e) {
      if (e.status === "leave") dots += `<span class="dot dot-leave"></span>`;
      else if (e.status === "paid-leave") dots += `<span class="dot dot-paid"></span>`;
      else if (e.status === "ot-only") dots += `<span class="dot dot-ot"></span>`;
      else {
        const { normalMin, otMin } = computeEntryMinutes(e, key);
        if (normalMin > 0) dots += `<span class="dot dot-work"></span>`;
        if (otMin > 0) dots += `<span class="dot dot-ot"></span>`;
      }
    }
    const isToday = key === todayStr;
    html += `<div class="cal-cell${isToday ? " is-today" : ""}${off ? " is-off" : ""}" data-key="${key}">
      <span>${d}</span>
      <div class="cdots">${dots}</div>
    </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll(".cal-cell:not(.empty)").forEach(cell => {
    cell.addEventListener("click", () => showCalDetail(cell.dataset.key));
  });

  $("#calDetail").textContent = "Tap a date to see details.";
}

function showCalDetail(key) {
  const e = entries[key];
  const detail = $("#calDetail");
  const d = new Date(key + "T00:00:00");
  const label = d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
  const off = isWeeklyOff(key);
  const [ky, km] = key.split("-").map(Number);
  if (!e) {
    detail.innerHTML = `<strong>${label}</strong>${off ? " · weekly off" : ""}<br>No record. <span style="text-decoration:underline;cursor:pointer" id="calAddLink">Add entry</span>`;
    $("#calAddLink").addEventListener("click", () => openEntryModal(key));
    return;
  }
  if (e.status === "leave") {
    detail.innerHTML = `<strong>${label}</strong><br>Unpaid leave · No salary earned for this day (${fmtMoney(dailySalary(ky, km - 1))} not added, no extra penalty)${e.notes ? "<br>Note: " + escapeHtml(e.notes) : ""}`;
  } else if (e.status === "paid-leave") {
    detail.innerHTML = `<strong>${label}</strong><br>Paid leave · Full day salary ${fmtMoney(dailySalary(ky, km - 1))}${e.notes ? "<br>Note: " + escapeHtml(e.notes) : ""}`;
  } else if (e.status === "ot-only") {
    const { otMin } = computeEntryMinutes(e, key);
    const otPay = (otMin/60) * config.otRate;
    const dSalary = dailySalary(ky, km - 1);
    const pay = dSalary + otPay;
    detail.innerHTML = `<strong>${label}</strong> · overtime only<br>No regular shift · Worked ${minutesToHM(otMin)} OT<br>Daily salary ${fmtMoney(dSalary)} + OT ${fmtMoney(otPay)} = <strong>${fmtMoney(pay)}</strong>${e.notes ? "<br>Note: " + escapeHtml(e.notes) : ""}`;
  } else {
    const { normalMin, otMin } = computeEntryMinutes(e, key);
    const otPay = (otMin/60) * config.otRate;
    const dSalary = dailySalary(ky, km - 1);
    let pay, offNote = "";
    if (off) {
      pay = dSalary + otPay;
      offNote = " · off-day, base salary + full OT";
    } else {
      const hS = hourlySalary(ky, km - 1);
      pay = (normalMin/60)*hS + otPay;
    }
    detail.innerHTML = `<strong>${label}</strong>${offNote}<br>${e.clockIn || "—"} → ${e.clockOut || "—"} · Worked ${minutesToHM(normalMin)}${otMin>0 ? ", OT " + minutesToHM(otMin) : ""}<br>Earned: <strong>${fmtMoney(pay)}</strong>${e.notes ? "<br>Note: " + escapeHtml(e.notes) : ""}`;
  }
}
function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

$("#calPrev").addEventListener("click", () => {
  calViewDate.setMonth(calViewDate.getMonth() - 1);
  renderCalendar();
});
$("#calNext").addEventListener("click", () => {
  calViewDate.setMonth(calViewDate.getMonth() + 1);
  renderCalendar();
});

/* ---------- Reports ---------- */
$$(".rtab[data-r]").forEach(t => {
  t.addEventListener("click", () => {
    $$(".rtab[data-r]").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    activeReportType = t.dataset.r;
    renderReports();
  });
});
$$(".rtab[data-h]").forEach(t => {
  t.addEventListener("click", () => {
    $$(".rtab[data-h]").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    activeHistoryType = t.dataset.h;
    renderHistory();
  });
});
$("#monthSearch").addEventListener("input", () => { renderReports(); renderHistory(); });

function getSearchFilter() {
  return $("#monthSearch").value.trim().toLowerCase();
}

function renderReports() {
  const body = $("#reportBody");
  const filter = getSearchFilter();
  let keys = Object.keys(entries).sort().reverse();

  if (filter) {
    keys = keys.filter(k => {
      const d = new Date(k + "T00:00:00");
      const label = d.toLocaleDateString("en-IN", { month: "long", year: "numeric" }).toLowerCase();
      return label.includes(filter);
    });
  }

  if (activeReportType === "daily") {
    keys = keys.slice(0, 31);
    body.innerHTML = keys.length ? keys.map(k => reportLineForDay(k)).join("") : emptyMsg();
  } else if (activeReportType === "weekly") {
    const weeks = groupByWeek(keys);
    body.innerHTML = weeks.length ? weeks.map(w => {
      const totalPay = w.keys.reduce((sum, k) => sum + dayPay(k), 0);
      return `<div class="report-line"><div><div class="rl-main">${w.label}</div><div class="rl-sub">${w.keys.length} entries</div></div><div class="rl-amt">${fmtMoney(totalPay)}</div></div>`;
    }).join("") : emptyMsg();
  } else {
    const months = groupByMonth(keys);
    body.innerHTML = months.length ? months.map(mo => {
      const totalPay = mo.keys.reduce((sum, k) => sum + dayPay(k), 0);
      const leaveDays = mo.keys.filter(k => entries[k].status === "leave" || entries[k].status === "paid-leave").length;
      return `<div class="report-line"><div><div class="rl-main">${mo.label}</div><div class="rl-sub">${mo.keys.length - leaveDays} worked · ${leaveDays} leave</div></div><div class="rl-amt">${fmtMoney(totalPay)}</div></div>`;
    }).join("") : emptyMsg();
  }
  renderHistory();
}

function reportLineForDay(k) {
  const e = entries[k];
  const d = new Date(k + "T00:00:00");
  const label = d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const pay = dayPay(k);
  const sub = e.status === "leave" ? "Unpaid Leave" : e.status === "paid-leave" ? "Paid Leave" : e.status === "ot-only" ? `OT only · ${e.otOnlyHours || 0}h` : (e.clockIn && e.clockOut ? `${e.clockIn} – ${e.clockOut}` : "Incomplete");
  return `<div class="report-line"><div><div class="rl-main">${label}</div><div class="rl-sub">${sub}</div></div><div class="rl-amt">${fmtMoney(pay)}</div></div>`;
}
function groupByWeek(keys) {
  const groups = {};
  keys.forEach(k => {
    const d = new Date(k + "T00:00:00");
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    const gid = `${d.getFullYear()}-W${week}`;
    if (!groups[gid]) groups[gid] = { label: `Week ${week}, ${d.getFullYear()}`, keys: [] };
    groups[gid].keys.push(k);
  });
  return Object.values(groups);
}
function groupByMonth(keys) {
  const groups = {};
  keys.forEach(k => {
    const [y,m] = k.split("-");
    const gid = `${y}-${m}`;
    if (!groups[gid]) groups[gid] = { label: monthName(Number(y), Number(m)-1), keys: [] };
    groups[gid].keys.push(k);
  });
  return Object.values(groups);
}
function emptyMsg() {
  return `<div class="empty-state">No records match.</div>`;
}

function renderHistory() {
  const body = $("#historyBody");
  const filter = getSearchFilter();
  let keys = Object.keys(entries).sort().reverse();
  if (filter) {
    keys = keys.filter(k => {
      const d = new Date(k + "T00:00:00");
      const label = d.toLocaleDateString("en-IN", { month: "long", year: "numeric" }).toLowerCase();
      return label.includes(filter);
    });
  }
  if (activeHistoryType === "salary") {
    keys = keys.filter(k => entries[k].status !== "leave" || true).slice(0, 60);
    body.innerHTML = keys.length ? keys.map(k => reportLineForDay(k)).join("") : emptyMsg();
  } else {
    keys = keys.filter(k => {
      const { otMin } = computeEntryMinutes(entries[k], k);
      return otMin > 0;
    }).slice(0, 60);
    body.innerHTML = keys.length ? keys.map(k => {
      const e = entries[k];
      const { otMin } = computeEntryMinutes(e, k);
      const d = new Date(k + "T00:00:00");
      const label = d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
      const pay = (otMin/60) * config.otRate;
      const sub = isWeeklyOff(k) ? `${minutesToHM(otMin)} · off-day OT` : `${minutesToHM(otMin)} overtime`;
      return `<div class="report-line"><div><div class="rl-main">${label}</div><div class="rl-sub">${sub}</div></div><div class="rl-amt">${fmtMoney(pay)}</div></div>`;
    }).join("") : `<div class="empty-state">No overtime recorded.</div>`;
  }
}

/* ---------- Export: CSV ---------- */
$("#exportCsv").addEventListener("click", () => {
  const keys = Object.keys(entries).sort();
  let csv = "Date,Status,Clock In,Clock Out,Normal Hours,Overtime Hours,Pay,Notes\n";
  keys.forEach(k => {
    const e = entries[k];
    const { normalMin, otMin } = computeEntryMinutes(e, k);
    const pay = dayPay(k);
    const row = [
      k,
      e.status,
      e.clockIn || "",
      e.clockOut || "",
      (normalMin/60).toFixed(2),
      (otMin/60).toFixed(2),
      pay.toFixed(2),
      `"${(e.notes||"").replace(/"/g,'""')}"`
    ].join(",");
    csv += row + "\n";
  });
  downloadFile("ledger-export.csv", csv, "text/csv");
  showToast("CSV exported");
});

/* ---------- Export: PDF (print-based, no external libs) ---------- */
$("#exportPdf").addEventListener("click", () => {
  buildPrintableReport();
  window.print();
});
$("#printReport").addEventListener("click", () => {
  buildPrintableReport();
  window.print();
});
function buildPrintableReport() {
  // Reports panel is already the printable one via CSS @media print rules.
  $$(".tab").forEach(t => t.classList.remove("active"));
  $('.tab[data-tab="reports"]').classList.add("active");
  $$(".panel").forEach(p => p.classList.remove("active"));
  $("#panel-reports").classList.add("active");
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------- Settings form ---------- */
function populateSettingsForm() {
  $("#cfgMonthlySalary").value = config.monthlySalary;
  $("#cfgOTRate").value = config.otRate;
  $("#cfgWorkStart").value = config.workStart;
  $("#cfgWorkEnd").value = config.workEnd;
  if ($("#cfgMaxOTHours")) $("#cfgMaxOTHours").value = config.maxOTHoursPerDay ?? 4;
  if ($("#cfgPaidLeaves")) $("#cfgPaidLeaves").value = config.paidLeavesPerMonth ?? 1;
  $$('#cfgWeeklyOff .wd-chip').forEach(chip => {
    const cb = chip.querySelector('input[type="checkbox"]');
    cb.checked = (config.weeklyOffDays || []).includes(Number(cb.value));
    chip.classList.toggle("is-checked", cb.checked);
  });
}
// Keep chip highlight in sync whenever a weekday checkbox is toggled
$$('#cfgWeeklyOff .wd-chip input[type="checkbox"]').forEach(cb => {
  cb.addEventListener("change", () => {
    cb.closest(".wd-chip").classList.toggle("is-checked", cb.checked);
  });
});
$("#settingsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const weeklyOffDays = Array.from($$('#cfgWeeklyOff input[type="checkbox"]:checked')).map(cb => Number(cb.value));
  const newConfig = {
    monthlySalary: Number($("#cfgMonthlySalary").value),
    otRate: Number($("#cfgOTRate").value),
    workStart: $("#cfgWorkStart").value,
    workEnd: $("#cfgWorkEnd").value,
    maxOTHoursPerDay: $("#cfgMaxOTHours") ? Number($("#cfgMaxOTHours").value) : (config.maxOTHoursPerDay ?? 4),
    paidLeavesPerMonth: $("#cfgPaidLeaves") ? Number($("#cfgPaidLeaves").value) : (config.paidLeavesPerMonth ?? 1),
    weeklyOffDays
  };
  if (newConfig.monthlySalary < 0 || newConfig.otRate < 0 || newConfig.paidLeavesPerMonth < 0 || newConfig.maxOTHoursPerDay < 0) {
    showToast("⚠ Values cannot be negative");
    return;
  }
  config = newConfig;
  saveConfig();
  showToast("Settings saved");
  refreshAll();
});

/* ---------- Backup / Restore / Reset ---------- */
$("#backupBtn").addEventListener("click", () => {
  const payload = { config, entries, exportedAt: new Date().toISOString() };
  downloadFile(`ledger-backup-${todayKey()}.json`, JSON.stringify(payload, null, 2), "application/json");
  showToast("Backup downloaded");
});
$("#restoreInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.config) config = { ...DEFAULT_CONFIG, ...data.config };
      if (data.entries) entries = data.entries;
      saveConfig(); saveEntries();
      populateSettingsForm();
      refreshAll();
      showToast("Backup restored");
    } catch (err) {
      showToast("⚠ Invalid backup file");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});
$("#resetBtn").addEventListener("click", () => {
  if (confirm("This will erase all settings and entries permanently. Continue?")) {
    if (confirm("Are you absolutely sure? This cannot be undone.")) {
      localStorage.removeItem(LS_CONFIG);
      localStorage.removeItem(LS_ENTRIES);
      config = { ...DEFAULT_CONFIG };
      entries = {};
      populateSettingsForm();
      refreshAll();
      showToast("All data reset");
    }
  }
});

/* ---------- Toast ---------- */
let toastTimer = null;
function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- Refresh all ---------- */
function refreshAll() {
  refreshTicket();
  renderDashboard();
  renderEntryList();
  renderCalendar();
  renderReports();
}

/* ---------- Init ---------- */
populateSettingsForm();
refreshAll();
setInterval(() => { refreshTicket(); renderDashboard(); }, 30000); // periodic refresh for live hours

/* ---------- Service worker registration (PWA) ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

})();
