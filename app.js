/* ===========================================================
   NoSchool CRM — приложение для репетитора
   Vanilla JS, без зависимостей. Данные хранятся в localStorage.
   =========================================================== */

(function () {
  "use strict";

  /* ---------------------------------------------------------
     SUPABASE CLIENT
  --------------------------------------------------------- */
  const CONFIG_MISSING = !window.SUPABASE_CONFIG ||
    !window.SUPABASE_CONFIG.url || !window.SUPABASE_CONFIG.anonKey ||
    window.SUPABASE_CONFIG.url.includes("ВАШ") || window.SUPABASE_CONFIG.anonKey.includes("ВАШ");

  const sbClient = CONFIG_MISSING ? null : window.supabase.createClient(
    window.SUPABASE_CONFIG.url,
    window.SUPABASE_CONFIG.anonKey
  );
  window.sbClient = sbClient; // для отладки через консоль браузера

  /* ---------------------------------------------------------
     ROW <-> APP OBJECT MAPPING
     (БД хранит snake_case, приложение работает с camelCase —
     остальной код экрана ничего не знает про эту разницу)
  --------------------------------------------------------- */
  function studentFromRow(r) {
    return {
      id: r.id, name: r.name, grade: r.grade, price: r.price, duration: r.duration,
      phone: r.phone, telegram: r.telegram, comment: r.comment, status: r.status,
      createdAt: r.created_at,
    };
  }
  function studentToRow(s) {
    return {
      name: s.name, grade: s.grade, price: s.price, duration: s.duration,
      phone: s.phone, telegram: s.telegram, comment: s.comment, status: s.status,
    };
  }
  function lessonFromRow(r) {
    return {
      id: r.id, studentId: r.student_id, date: r.date,
      time: r.time ? r.time.slice(0, 5) : r.time,
      status: r.status, paid: r.paid, homework: r.homework, hwDone: r.hw_done,
      comment: r.comment, price: r.price, createdAt: r.created_at,
    };
  }
  function lessonToRow(l) {
    return {
      student_id: l.studentId, date: l.date, time: l.time, status: l.status,
      paid: !!l.paid, homework: l.homework || "", hw_done: !!l.hwDone,
      comment: l.comment || "", price: l.price,
    };
  }
  function expenseFromRow(r) {
    return { id: r.id, title: r.title, amount: r.amount, date: r.date };
  }
  function expenseToRow(e) {
    return { title: e.title, amount: e.amount, date: e.date };
  }

  /* ---------------------------------------------------------
     CRUD HELPERS
     Каждая функция возвращает готовый объект приложения (или null при ошибке)
     и сама показывает toast с ошибкой — вызывающему коду достаточно
     проверить результат на null.
  --------------------------------------------------------- */
  // Счётчик запросов: если пока шёл один dbFetchAll() успел стартовать
  // и завершиться более новый вызов, устаревший ответ должен быть отброшен,
  // а не перезаписывать поверх уже более свежие данные. Без этой защиты
  // два перекрывающихся вызова (например, при быстром logout → login,
  // или при параллельных событиях авторизации) могут прийти в обратном
  // порядке и откатить состояние экрана назад — именно это выглядело как
  // «пропавший ученик» и «лишний дубль».
  let fetchSeq = 0;

  async function dbFetchAll() {
    const mySeq = ++fetchSeq;
    const [studentsRes, lessonsRes, expensesRes] = await Promise.all([
      sbClient.from("students").select("*").order("name"),
      sbClient.from("lessons").select("*"),
      sbClient.from("expenses").select("*"),
    ]);
    if (mySeq !== fetchSeq) return; // пришёл устаревший ответ — игнорируем
    if (studentsRes.error || lessonsRes.error || expensesRes.error) {
      console.error(studentsRes.error || lessonsRes.error || expensesRes.error);
      showToast("Не удалось загрузить данные");
    }
    state.students = (studentsRes.data || []).map(studentFromRow);
    state.lessons = (lessonsRes.data || []).map(lessonFromRow);
    state.expenses = (expensesRes.data || []).map(expenseFromRow);
  }

  // Защита от повторной отправки: если пользователь нажмёт «Сохранить»
  // дважды подряд (двойной клик, медленная сеть), второй вызов с тем же
  // ключом игнорируется, пока первый не завершится. Это устраняет
  // дублирование записей (например, «три Максима вместо двух»).
  const inFlight = new Set();
  async function withGuard(key, fn) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try { return await fn(); }
    finally { inFlight.delete(key); }
  }

  async function dbInsertStudent(data) {
    const { data: row, error } = await sbClient.from("students").insert(studentToRow(data)).select().single();
    if (error) { console.error(error); showToast("Не удалось сохранить ученика"); return null; }
    return studentFromRow(row);
  }
  async function dbUpdateStudent(id, data) {
    const { error } = await sbClient.from("students").update(studentToRow(data)).eq("id", id);
    if (error) { console.error(error); showToast("Не удалось сохранить изменения"); return false; }
    return true;
  }
  async function dbDeleteStudent(id) {
    const { error } = await sbClient.from("students").delete().eq("id", id);
    if (error) { console.error(error); showToast("Не удалось удалить ученика"); return false; }
    return true;
  }

  async function dbInsertLesson(data) {
    const { data: row, error } = await sbClient.from("lessons").insert(lessonToRow(data)).select().single();
    if (error) { console.error(error); showToast("Не удалось сохранить занятие"); return null; }
    return lessonFromRow(row);
  }
  async function dbUpdateLesson(id, data) {
    const { error } = await sbClient.from("lessons").update(lessonToRow(data)).eq("id", id);
    if (error) { console.error(error); showToast("Не удалось сохранить занятие"); return false; }
    return true;
  }
  async function dbDeleteLesson(id) {
    const { error } = await sbClient.from("lessons").delete().eq("id", id);
    if (error) { console.error(error); showToast("Не удалось удалить занятие"); return false; }
    return true;
  }

  async function dbInsertExpense(data) {
    const { data: row, error } = await sbClient.from("expenses").insert(expenseToRow(data)).select().single();
    if (error) { console.error(error); showToast("Не удалось сохранить расход"); return null; }
    return expenseFromRow(row);
  }
  async function dbDeleteExpense(id) {
    const { error } = await sbClient.from("expenses").delete().eq("id", id);
    if (error) { console.error(error); showToast("Не удалось удалить расход"); return false; }
    return true;
  }

  /* ---------------------------------------------------------
     STATE
  --------------------------------------------------------- */
  const state = {
    session: null,
    authMode: "signin",
    students: [],
    lessons: [],
    expenses: [],
    view: "home",
    schedule: { mode: "week", weekStart: null, selectedDate: null },
    studentDetail: { id: null, tab: "history" },
    stats: { period: "today" },
    finance: { filter: "month" },
    studentsFilter: { query: "", status: "all" },
    conduct: null, // transient multi-step flow
  };
  window.appState = state; // для отладки через консоль браузера

  /* ---------------------------------------------------------
     DATE HELPERS (local time, no timezone surprises)
  --------------------------------------------------------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  function isoFromDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function todayISO() { return isoFromDate(new Date()); }
  function dateFromISO(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(iso, n) {
    const d = dateFromISO(iso);
    d.setDate(d.getDate() + n);
    return isoFromDate(d);
  }
  function startOfWeekISO(iso) {
    const d = dateFromISO(iso);
    const day = (d.getDay() + 6) % 7; // 0 = Monday
    d.setDate(d.getDate() - day);
    return isoFromDate(d);
  }
  const WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const WEEKDAY_FULL = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
  const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  function weekdayShort(iso) { return WEEKDAY_SHORT[(dateFromISO(iso).getDay() + 6) % 7]; }
  function weekdayFull(iso) { return WEEKDAY_FULL[(dateFromISO(iso).getDay() + 6) % 7]; }
  function humanDate(iso) { const d = dateFromISO(iso); return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`; }
  function humanDateYear(iso) { const d = dateFromISO(iso); return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`; }
  function nowHHMM() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function combineTS(dateISO, time) {
    const [h, m] = (time || "00:00").split(":").map(Number);
    const d = dateFromISO(dateISO);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }
  function isToday(iso) { return iso === todayISO(); }

  /* ---------------------------------------------------------
     FORMATTERS
  --------------------------------------------------------- */
  function money(n) {
    const v = Math.round(n || 0);
    return v.toLocaleString("ru-RU") + " ₽";
  }
  function escapeHTML(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function initials(name) {
    const parts = (name || "").trim().split(/\s+/);
    return (parts[0]?.[0] || "?").toUpperCase();
  }

  const STATUS_LABEL = {
    planned: "Запланировано",
    done: "Проведено",
    cancelled: "Отменено",
    moved: "Перенесено",
  };
  const STATUS_BADGE_CLASS = {
    planned: "accent",
    done: "success",
    cancelled: "danger",
    moved: "warning",
  };

  /* ---------------------------------------------------------
     DERIVED DATA
  --------------------------------------------------------- */
  function getStudent(id) { return state.students.find((s) => s.id === id); }

  function lessonsOnDate(iso) {
    return state.lessons
      .filter((l) => l.date === iso)
      .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  }

  function lessonsForStudent(id) {
    return state.lessons
      .filter((l) => l.studentId === id)
      .sort((a, b) => combineTS(b.date, b.time) - combineTS(a.date, a.time));
  }

  function nextLesson() {
    const now = Date.now();
    return state.lessons
      .filter((l) => l.status === "planned" && combineTS(l.date, l.time) >= now)
      .sort((a, b) => combineTS(a.date, a.time) - combineTS(b.date, b.time))[0] || null;
  }

  function todayIncome() {
    return state.lessons
      .filter((l) => l.date === todayISO() && l.status === "done")
      .reduce((sum, l) => sum + (l.price || 0), 0);
  }

  function todayLessonsCount() {
    return lessonsOnDate(todayISO()).length;
  }

  function unpaidLessonsCount() {
    return state.lessons.filter((l) => l.status === "done" && !l.paid).length;
  }

  function studentDebt(id) {
    return state.lessons
      .filter((l) => l.studentId === id && l.status === "done" && !l.paid)
      .reduce((sum, l) => sum + (l.price || 0), 0);
  }
  function studentTotalEarned(id) {
    return state.lessons
      .filter((l) => l.studentId === id && l.status === "done")
      .reduce((sum, l) => sum + (l.price || 0), 0);
  }
  function studentLessonsDone(id) {
    return state.lessons.filter((l) => l.studentId === id && l.status === "done").length;
  }

  function periodRange(period) {
    const today = todayISO();
    if (period === "today") return [today, today];
    if (period === "week") return [addDays(today, -6), today];
    if (period === "month") return [addDays(today, -29), today];
    if (period === "year") return [addDays(today, -364), today];
    return [today, today];
  }

  function inRange(dateISO, range) { return dateISO >= range[0] && dateISO <= range[1]; }

  function incomeLessonsInRange(range) {
    return state.lessons
      .filter((l) => l.status === "done" && inRange(l.date, range))
      .sort((a, b) => combineTS(b.date, b.time) - combineTS(a.date, a.time));
  }
  function expensesInRange(range) {
    return state.expenses
      .filter((e) => inRange(e.date, range))
      .sort((a, b) => (b.date).localeCompare(a.date));
  }

  function statsForPeriod(period) {
    const range = periodRange(period);
    const done = state.lessons.filter((l) => l.status === "done" && inRange(l.date, range));
    const cancelled = state.lessons.filter((l) => l.status === "cancelled" && inRange(l.date, range));
    const moved = state.lessons.filter((l) => l.status === "moved" && inRange(l.date, range));
    const revenue = done.reduce((s, l) => s + (l.price || 0), 0);
    const lessonsCount = done.length;
    const avgPrice = lessonsCount ? revenue / lessonsCount : 0;

    const byStudent = {};
    done.forEach((l) => { byStudent[l.studentId] = (byStudent[l.studentId] || 0) + (l.price || 0); });
    let topStudent = null, topAmount = 0;
    Object.entries(byStudent).forEach(([sid, amt]) => {
      if (amt > topAmount) { topAmount = amt; topStudent = sid; }
    });

    return {
      revenue, lessonsCount, avgPrice,
      cancels: cancelled.length, moved: moved.length,
      topStudent: topStudent ? getStudent(topStudent) : null,
      topAmount,
      trend: buildTrend(period, range, done),
    };
  }

  function buildTrend(period, range, doneLessons) {
    const buckets = [];
    if (period === "today") {
      return []; // не показываем тренд для одного дня
    }
    if (period === "week") {
      for (let i = 0; i < 7; i++) {
        const d = addDays(range[0], i);
        const amt = doneLessons.filter((l) => l.date === d).reduce((s, l) => s + (l.price || 0), 0);
        buckets.push({ label: weekdayShort(d), amt });
      }
    } else if (period === "month") {
      // 5 недельных корзин
      for (let i = 0; i < 5; i++) {
        const start = addDays(range[0], i * 6);
        const end = i === 4 ? range[1] : addDays(range[0], i * 6 + 5);
        const amt = doneLessons.filter((l) => l.date >= start && l.date <= end)
          .reduce((s, l) => s + (l.price || 0), 0);
        buckets.push({ label: `${i + 1}`, amt });
      }
    } else if (period === "year") {
      const now = dateFromISO(range[1]);
      for (let i = 11; i >= 0; i--) {
        const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const label = MONTHS_NOM[m.getMonth()].slice(0, 3);
        const y = m.getFullYear(), mo = m.getMonth();
        const amt = doneLessons.filter((l) => {
          const ld = dateFromISO(l.date);
          return ld.getFullYear() === y && ld.getMonth() === mo;
        }).reduce((s, l) => s + (l.price || 0), 0);
        buckets.push({ label, amt });
      }
    }
    return buckets;
  }

  /* ---------------------------------------------------------
     NAVIGATION
  --------------------------------------------------------- */
  function goTo(view, extra) {
    state.view = view;
    if (extra) Object.assign(state, extra);
    render();
    document.getElementById("app").scrollTo?.(0, 0);
    window.scrollTo(0, 0);
  }
  window.goTo = goTo;

  function ensureScheduleInit() {
    if (!state.schedule.selectedDate) state.schedule.selectedDate = todayISO();
    if (!state.schedule.weekStart) state.schedule.weekStart = startOfWeekISO(state.schedule.selectedDate);
  }

  /* ---------------------------------------------------------
     TOAST
  --------------------------------------------------------- */
  let toastTimer = null;
  function showToast(msg) {
    const root = document.getElementById("toast-root");
    root.innerHTML = `<div class="toast">${escapeHTML(msg)}</div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { root.innerHTML = ""; }, 2200);
  }
  window.showToast = showToast;

  /* ---------------------------------------------------------
     MODAL
  --------------------------------------------------------- */
  function openModal(html) {
    document.getElementById("modal-root").innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this) closeModal()">
        <div class="modal-sheet" role="dialog" aria-modal="true">
          <div class="modal-handle"></div>
          ${html}
        </div>
      </div>`;
  }
  function closeModal() { document.getElementById("modal-root").innerHTML = ""; }
  window.closeModal = closeModal;

  /* ---------------------------------------------------------
     RENDER: SHELL
  --------------------------------------------------------- */
  function render() {
    const app = document.getElementById("app");
    if (CONFIG_MISSING) { app.innerHTML = renderSetupNeeded(); return; }
    if (state.authMode === "reset") { app.innerHTML = renderResetScreen(); return; }
    if (!state.session) { app.innerHTML = renderAuthScreen(); return; }
    app.innerHTML = `${renderTopbar()}<div class="view">${renderView()}</div>${renderBottomNav()}`;
  }

  function renderSetupNeeded() {
    return `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
        <div class="card" style="max-width:420px">
          <div class="card-title">Нужна настройка</div>
          <div style="font-weight:700;font-size:18px;margin-bottom:8px">Supabase ещё не подключён</div>
          <div class="small muted">Откройте файл <b>config.js</b> в проекте и вставьте туда
          URL и anon key вашего проекта Supabase (Project Settings → API), затем обновите страницу.</div>
        </div>
      </div>`;
  }

  function renderAuthScreen() {
    const mode = state.authMode;
    return `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
        <div class="card" style="width:100%;max-width:360px">
          <div style="text-align:center;margin-bottom:18px">
            <div style="font-size:28px;font-weight:700;font-family:var(--font-display)">NoSchool</div>
            <div class="muted small">${mode === "signin" ? "Вход в CRM" : "Регистрация репетитора"}</div>
          </div>
          <div class="field"><label>Email</label><input type="text" id="auth-email" placeholder="you@example.com" autocomplete="username" /></div>
          <div class="field"><label>Пароль</label><input type="password" id="auth-password" placeholder="Минимум 6 символов" autocomplete="current-password" /></div>
          <div id="auth-error" class="small" style="min-height:18px;margin-bottom:6px;color:var(--danger)"></div>
          <button class="btn btn-primary" id="auth-submit" onclick="${mode === "signin" ? "authSignIn()" : "authSignUp()"}">
            ${mode === "signin" ? "Войти" : "Зарегистрироваться"}
          </button>
          <button class="btn btn-ghost" style="width:100%;margin-top:6px" onclick="authToggleMode()">
            ${mode === "signin" ? "Нет аккаунта? Зарегистрироваться" : "Уже есть аккаунт? Войти"}
          </button>
          ${mode === "signin" ? `<button class="btn btn-ghost" style="width:100%" onclick="authForgotPassword()">Забыли пароль?</button>` : ""}
        </div>
      </div>`;
  }

  window.authToggleMode = function () {
    state.authMode = state.authMode === "signin" ? "signup" : "signin";
    render();
  };

  function authSetError(msg, ok) {
    const el = document.getElementById("auth-error");
    if (el) { el.style.color = ok ? "var(--success)" : "var(--danger)"; el.textContent = msg; }
  }

  window.authSignIn = async function () {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    if (!email || !password) { authSetError("Введите email и пароль"); return; }
    const btn = document.getElementById("auth-submit"); btn.disabled = true;
    const { error } = await sbClient.auth.signInWithPassword({ email, password });
    if (error) { authSetError("Неверный email или пароль"); btn.disabled = false; return; }
    // Дальше state.session/данные подтянутся через onAuthStateChange
  };

  window.authSignUp = async function () {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    if (!email || password.length < 6) { authSetError("Email обязателен, пароль — минимум 6 символов"); return; }
    const btn = document.getElementById("auth-submit"); btn.disabled = true;
    const { data, error } = await sbClient.auth.signUp({ email, password });
    if (error) { authSetError(error.message); btn.disabled = false; return; }
    if (!data.session) {
      state.authMode = "signin";
      render();
      authSetError("Проверьте почту и подтвердите регистрацию, затем войдите", true);
      return;
    }
    // Дальше state.session/данные подтянутся через onAuthStateChange
  };

  window.authForgotPassword = async function () {
    const email = document.getElementById("auth-email").value.trim();
    if (!email) { authSetError("Сначала введите email в поле выше"); return; }
    const { error } = await sbClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.href.split("#")[0].split("?")[0],
    });
    if (error) { authSetError(error.message); return; }
    authSetError("Письмо со ссылкой для сброса пароля отправлено на " + email, true);
  };

  function renderResetScreen() {
    return `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
        <div class="card" style="width:100%;max-width:360px">
          <div style="text-align:center;margin-bottom:18px">
            <div style="font-size:28px;font-weight:700;font-family:var(--font-display)">NoSchool</div>
            <div class="muted small">Придумайте новый пароль</div>
          </div>
          <div class="field"><label>Новый пароль</label><input type="password" id="new-password" placeholder="Минимум 6 символов" autocomplete="new-password" /></div>
          <div id="auth-error" class="small" style="min-height:18px;margin-bottom:6px;color:var(--danger)"></div>
          <button class="btn btn-primary" onclick="authSetNewPassword()">Сохранить пароль</button>
        </div>
      </div>`;
  }

  window.authSetNewPassword = async function () {
    const pw = document.getElementById("new-password").value;
    if (pw.length < 6) { authSetError("Минимум 6 символов"); return; }
    const { error } = await sbClient.auth.updateUser({ password: pw });
    if (error) { authSetError(error.message); return; }
    state.authMode = "signin";
    showToast("Пароль обновлён");
    render();
  };
  window.authSignOut = async function () {
    await sbClient.auth.signOut();
    state.session = null;
    state.students = []; state.lessons = []; state.expenses = [];
    render();
  };

  const TOPBAR_TITLES = {
    home: null,
    schedule: "Расписание",
    students: "Ученики",
    studentDetail: null,
    finances: "Финансы",
    stats: "Статистика",
  };

  function renderTopbar() {
    if (state.view === "home") {
      const d = todayISO();
      return `<div class="topbar">
        <div class="eyebrow">${weekdayFull(d)}, ${humanDate(d)}</div>
        <h1>NoSchool</h1>
      </div>`;
    }
    if (state.view === "studentDetail") {
      const st = getStudent(state.studentDetail.id);
      return `<div class="topbar">
        <button class="back" onclick="goTo('students')">‹ Ученики</button>
        <h1>${escapeHTML(st ? st.name : "Ученик")}</h1>
      </div>`;
    }
    const title = TOPBAR_TITLES[state.view] || "";
    let action = "";
    if (state.view === "students") action = `<button class="back" style="float:right;color:var(--ink)" onclick="openAddStudent()">+ Добавить</button>`;
    if (state.view === "schedule") action = `<button class="back" style="float:right;color:var(--ink)" onclick="openAddLesson(state_scheduleDate())">+ Занятие</button>`;
    if (state.view === "finances") action = `<button class="back" style="float:right;color:var(--ink)" onclick="openAddExpense()">+ Расход</button>`;
    return `<div class="topbar">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h1 style="margin:0">${title}</h1>
        ${action}
      </div>
    </div>`;
  }
  window.state_scheduleDate = function () { ensureScheduleInit(); return state.schedule.selectedDate; };

  const NAV_ITEMS = [
    { id: "home", label: "Главная", ico: "🏠" },
    { id: "schedule", label: "Расписание", ico: "📅" },
    { id: "students", label: "Ученики", ico: "👨‍🎓" },
    { id: "finances", label: "Финансы", ico: "💰" },
    { id: "stats", label: "Статистика", ico: "📊" },
  ];
  function renderBottomNav() {
    const active = state.view === "studentDetail" ? "students" : state.view;
    return `<div class="bottom-nav">
      ${NAV_ITEMS.map((n) => `
        <button class="nav-item ${active === n.id ? "active" : ""}" onclick="goTo('${n.id}')">
          <span class="ico">${n.ico}</span><span>${n.label}</span>
        </button>`).join("")}
    </div>`;
  }

  function renderView() {
    switch (state.view) {
      case "home": return renderHome();
      case "schedule": return renderSchedule();
      case "students": return renderStudents();
      case "studentDetail": return renderStudentDetail();
      case "finances": return renderFinances();
      case "stats": return renderStats();
      default: return renderHome();
    }
  }

  /* ---------------------------------------------------------
     HOME VIEW
  --------------------------------------------------------- */
  function renderHome() {
    const income = todayIncome();
    const cnt = todayLessonsCount();
    const unpaid = unpaidLessonsCount();
    const next = nextLesson();
    const todays = lessonsOnDate(todayISO());

    const nextBlock = next ? `
      <div class="next-lesson">
        <div class="time">${next.time}</div>
        <div style="flex:1">
          <div class="who">${escapeHTML(getStudent(next.studentId)?.name || "Ученик")}</div>
          <div class="sub">${next.date === todayISO() ? "сегодня" : humanDate(next.date)} · ближайшее занятие</div>
        </div>
      </div>` : "";

    return `
      <div class="hero">
        <div class="hero-label">Доход за сегодня</div>
        <div class="hero-amount">${money(income)}</div>
        <div class="hero-stats">
          <div class="hero-stat"><div class="n">${cnt}</div><div class="l">занятий сегодня</div></div>
          <div class="hero-stat"><div class="n">${unpaid}</div><div class="l">не оплачено всего</div></div>
        </div>
        ${nextBlock}
      </div>

      <div class="quick-grid">
        <button class="quick-btn primary" onclick="openConductLesson()"><span class="ico">➕</span> Провести занятие</button>
        <button class="quick-btn" onclick="goTo('schedule')"><span class="ico">📅</span>Расписание</button>
        <button class="quick-btn" onclick="goTo('students')"><span class="ico">👨‍🎓</span>Ученики</button>
        <button class="quick-btn" onclick="goTo('finances')"><span class="ico">💰</span>Финансы</button>
        <button class="quick-btn" onclick="goTo('stats')"><span class="ico">📊</span>Статистика</button>
      </div>

      <div class="card">
        <div class="card-title">Занятия сегодня</div>
        ${todays.length === 0 ? `<div class="empty"><div class="ico">📭</div><div class="t">Сегодня занятий нет</div><div class="s">Добавьте занятие в расписании</div></div>` :
        todays.map((l) => lessonRowHTML(l)).join("")}
      </div>

      <div class="small muted" style="text-align:center;margin-top:16px">Вы вошли как ${escapeHTML(state.session?.user?.email || "")}</div>
      <button class="link-danger" style="display:block;margin:0 auto" onclick="authSignOut()">Выйти из аккаунта</button>
    `;
  }

  function lessonRowHTML(l) {
    const st = getStudent(l.studentId);
    return `<div class="lesson-row row-tap" onclick="openEditLesson('${l.id}')">
      <div class="lt">${l.time}</div>
      <div class="lm">
        <div class="lname">${escapeHTML(st ? st.name : "Ученик удалён")}</div>
        <div class="lsub">${money(l.price)} ${l.status === "done" ? (l.paid ? "· оплачено" : "· не оплачено") : ""}</div>
      </div>
      <span class="badge ${STATUS_BADGE_CLASS[l.status]}">${STATUS_LABEL[l.status]}</span>
    </div>`;
  }

  /* ---------------------------------------------------------
     SCHEDULE VIEW
  --------------------------------------------------------- */
  function renderSchedule() {
    ensureScheduleInit();
    const ws = state.schedule.weekStart;
    const sel = state.schedule.selectedDate;
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));

    const weekStrip = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <button class="back" onclick="scheduleShiftWeek(-1)">‹</button>
        <div class="small muted" style="font-weight:600">${humanDate(ws)} – ${humanDate(addDays(ws, 6))}</div>
        <button class="back" onclick="scheduleShiftWeek(1)">›</button>
      </div>
      <div class="week-strip">
        ${days.map((d) => `
          <button class="week-day ${d === sel ? "selected" : ""} ${isToday(d) ? "today" : ""} ${lessonsOnDate(d).length ? "has-lessons" : ""}"
            onclick="scheduleSelectDay('${d}')">
            <div class="d">${weekdayShort(d)}</div>
            <div class="n">${dateFromISO(d).getDate()}</div>
            <div class="dot"></div>
          </button>`).join("")}
      </div>`;

    const modeToggle = `
      <div class="segmented" style="margin-bottom:14px">
        <button class="${state.schedule.mode === "week" ? "active" : ""}" onclick="scheduleSetMode('week')">Неделя</button>
        <button class="${state.schedule.mode === "day" ? "active" : ""}" onclick="scheduleSetMode('day')">День</button>
      </div>`;

    let body = "";
    if (state.schedule.mode === "day") {
      const list = lessonsOnDate(sel);
      body = `
        <div class="day-group-title">${weekdayFull(sel)}, ${humanDate(sel)}</div>
        ${list.length === 0 ? emptyBlock("🗓️", "Занятий нет", "Нажмите «+ Занятие», чтобы добавить") :
        list.map((l) => scheduleLessonRow(l)).join("")}
      `;
    } else {
      body = days.map((d) => {
        const list = lessonsOnDate(d);
        if (list.length === 0) return "";
        return `<div class="day-group-title">${weekdayFull(d)}${isToday(d) ? " · сегодня" : ""}</div>
          ${list.map((l) => scheduleLessonRow(l)).join("")}`;
      }).join("");
      if (!body.trim()) body = emptyBlock("🗓️", "На этой неделе занятий нет", "Нажмите «+ Занятие», чтобы добавить");
    }

    return `${weekStrip}${modeToggle}${body}`;
  }

  function scheduleLessonRow(l) {
    const st = getStudent(l.studentId);
    return `<div class="lesson-row row-tap" onclick="openEditLesson('${l.id}')">
      <div class="lt">${l.time}</div>
      <div class="lm">
        <div class="lname">${escapeHTML(st ? st.name : "Ученик удалён")}</div>
        <div class="lsub">${humanDate(l.date)} · ${money(l.price)}</div>
      </div>
      <span class="badge ${STATUS_BADGE_CLASS[l.status]}">${STATUS_LABEL[l.status]}</span>
    </div>`;
  }

  function emptyBlock(ico, title, sub) {
    return `<div class="empty"><div class="ico">${ico}</div><div class="t">${title}</div><div class="s">${sub}</div></div>`;
  }

  window.scheduleShiftWeek = function (dir) {
    state.schedule.weekStart = addDays(state.schedule.weekStart, dir * 7);
    render();
  };
  window.scheduleSelectDay = function (d) {
    state.schedule.selectedDate = d;
    state.schedule.mode = "day";
    render();
  };
  window.scheduleSetMode = function (m) { state.schedule.mode = m; render(); };

  /* ---------------------------------------------------------
     STUDENTS LIST VIEW
  --------------------------------------------------------- */
  function renderStudents() {
    const { query, status } = state.studentsFilter;
    let list = state.students.slice();
    if (status !== "all") list = list.filter((s) => s.status === status);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(q));
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "ru"));

    return `
      <input class="search-input" placeholder="Поиск ученика…" value="${escapeHTML(query)}"
        oninput="studentsSetQuery(this.value)" />
      <div class="tabs-scroll">
        <button class="pill-tab ${status === "all" ? "active" : ""}" onclick="studentsSetStatus('all')">Все</button>
        <button class="pill-tab ${status === "active" ? "active" : ""}" onclick="studentsSetStatus('active')">Активные</button>
        <button class="pill-tab ${status === "paused" ? "active" : ""}" onclick="studentsSetStatus('paused')">Пауза</button>
      </div>
      <div class="card" style="padding:6px 12px">
        ${list.length === 0 ? emptyBlock("👨‍🎓", "Учеников пока нет", "Нажмите «+ Добавить» вверху экрана") :
        list.map((s) => studentRowHTML(s)).join("")}
      </div>
    `;
  }

  function studentRowHTML(s) {
    const debt = studentDebt(s.id);
    return `<div class="row row-tap" onclick="goTo('studentDetail', {studentDetail:{id:'${s.id}', tab:'history'}})">
      <div class="avatar">${initials(s.name)}</div>
      <div class="row-main">
        <div class="row-title">${escapeHTML(s.name)}</div>
        <div class="row-sub">${escapeHTML(s.grade || "—")} · ${money(s.price)}${s.status === "paused" ? " · на паузе" : ""}</div>
      </div>
      <div class="row-trail">
        ${debt > 0 ? `<span class="badge danger">долг ${money(debt)}</span>` : `<span class="badge neutral">без долгов</span>`}
      </div>
      <span class="chev">›</span>
    </div>`;
  }

  window.studentsSetQuery = function (v) { state.studentsFilter.query = v; render(); focusSearchEnd(); };
  window.studentsSetStatus = function (v) { state.studentsFilter.status = v; render(); };
  function focusSearchEnd() {
    const el = document.querySelector(".search-input");
    if (el) { el.focus(); const v = el.value; el.value = ""; el.value = v; }
  }

  /* ---------------------------------------------------------
     STUDENT DETAIL VIEW
  --------------------------------------------------------- */
  function renderStudentDetail() {
    const st = getStudent(state.studentDetail.id);
    if (!st) return emptyBlock("🙈", "Ученик не найден", "Возможно, он был удалён");

    const debt = studentDebt(st.id);
    const earned = studentTotalEarned(st.id);
    const doneCount = studentLessonsDone(st.id);
    const tab = state.studentDetail.tab;

    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:20px;font-weight:700">${escapeHTML(st.name)}</div>
            <div class="muted small" style="margin-top:2px">${escapeHTML(st.grade || "—")} · ${st.duration} мин · ${money(st.price)}</div>
          </div>
          <span class="badge ${st.status === "active" ? "success" : "neutral"}">${st.status === "active" ? "Активный" : "Пауза"}</span>
        </div>
        ${st.phone || st.telegram ? `<div class="section-gap small muted">
          ${st.phone ? `📞 ${escapeHTML(st.phone)}` : ""} ${st.telegram ? `&nbsp;&nbsp;✈️ ${escapeHTML(st.telegram)}` : ""}
        </div>` : ""}
        ${st.comment ? `<div class="small muted section-gap">💬 ${escapeHTML(st.comment)}</div>` : ""}
        <div class="btn-row section-gap">
          <button class="btn btn-primary" onclick="openConductLesson('${st.id}')">➕ Провести занятие</button>
          <button class="btn btn-secondary" onclick="openEditStudent('${st.id}')" style="max-width:52px">✎</button>
        </div>
      </div>

      <div class="stat-grid" style="margin-bottom:14px">
        <div class="stat-tile"><div class="v" style="color:${debt > 0 ? "var(--danger)" : "var(--ink)"}">${money(debt)}</div><div class="l">Текущий долг</div></div>
        <div class="stat-tile"><div class="v">${doneCount}</div><div class="l">Занятий проведено</div></div>
        <div class="stat-tile" style="grid-column:1/-1"><div class="v">${money(earned)}</div><div class="l">Всего заработано с ученика</div></div>
      </div>

      <div class="segmented" style="margin-bottom:12px">
        <button class="${tab === "history" ? "active" : ""}" onclick="studentDetailTab('history')">История</button>
        <button class="${tab === "homework" ? "active" : ""}" onclick="studentDetailTab('homework')">Задания</button>
      </div>

      ${tab === "history" ? renderStudentHistory(st.id) : renderStudentHomework(st.id)}

      <button class="link-danger section-gap" onclick="deleteStudent('${st.id}')">Удалить ученика</button>
    `;
  }

  function renderStudentHistory(id) {
    const list = lessonsForStudent(id);
    if (!list.length) return emptyBlock("📜", "Пока нет занятий", "История появится после первого занятия");
    return `<div class="card" style="padding:6px 12px">${list.map((l) => `
      <div class="row row-tap" onclick="openEditLesson('${l.id}')">
        <div class="row-main">
          <div class="row-title">${humanDate(l.date)} · ${l.time}</div>
          <div class="row-sub">${l.comment ? escapeHTML(l.comment) : "&nbsp;"}</div>
        </div>
        <div class="row-trail">
          <div class="row-amount">${money(l.price)}</div>
          <div style="margin-top:4px">
            <span class="badge ${STATUS_BADGE_CLASS[l.status]}">${STATUS_LABEL[l.status]}</span>
            ${l.status === "done" ? `<span class="badge ${l.paid ? "success" : "danger"}" style="margin-left:4px">${l.paid ? "оплачено" : "не оплачено"}</span>` : ""}
          </div>
        </div>
      </div>`).join("")}</div>`;
  }

  function renderStudentHomework(id) {
    const list = lessonsForStudent(id).filter((l) => l.homework && l.homework.trim());
    if (!list.length) return emptyBlock("📚", "Заданий пока нет", "Добавляйте домашнее задание при проведении занятия");
    return `<div class="card" style="padding:6px 12px">${list.map((l) => `
      <div class="row">
        <div class="row-main">
          <div class="row-title">${escapeHTML(l.homework)}</div>
          <div class="row-sub">выдано ${humanDate(l.date)}</div>
        </div>
        <button class="badge ${l.hwDone ? "success" : "warning"}" style="border:none" onclick="toggleHomeworkDone('${l.id}')">
          ${l.hwDone ? "выполнено" : "в процессе"}
        </button>
      </div>`).join("")}</div>`;
  }

  window.studentDetailTab = function (tab) { state.studentDetail.tab = tab; render(); };
  window.toggleHomeworkDone = async function (lessonId) {
    const l = state.lessons.find((x) => x.id === lessonId);
    if (!l) return;
    const ok = await dbUpdateLesson(lessonId, { ...l, hwDone: !l.hwDone });
    if (!ok) return;
    l.hwDone = !l.hwDone;
    render();
  };
  window.deleteStudent = async function (id) {
    if (!confirm("Удалить ученика и всю историю его занятий? Действие необратимо.")) return;
    const ok = await dbDeleteStudent(id);
    if (!ok) return;
    state.students = state.students.filter((s) => s.id !== id);
    state.lessons = state.lessons.filter((l) => l.studentId !== id); // каскад на стороне БД, здесь просто чистим кэш
    showToast("Ученик удалён");
    goTo("students");
  };

  /* ---------------------------------------------------------
     ADD / EDIT STUDENT MODAL
  --------------------------------------------------------- */
  window.openAddStudent = function () { renderStudentForm(null); };
  window.openEditStudent = function (id) { renderStudentForm(getStudent(id)); };

  function renderStudentForm(st) {
    const isEdit = !!st;
    openModal(`
      <div class="modal-header"><h2>${isEdit ? "Редактировать ученика" : "Новый ученик"}</h2>
        <button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="field"><label>Имя</label><input type="text" id="f-name" value="${escapeHTML(st?.name || "")}" placeholder="Например, Максим" /></div>
      <div class="field-row">
        <div class="field"><label>Класс</label><input type="text" id="f-grade" value="${escapeHTML(st?.grade || "")}" placeholder="9 класс" /></div>
        <div class="field"><label>Статус</label>
          <select id="f-status">
            <option value="active" ${st?.status !== "paused" ? "selected" : ""}>Активный</option>
            <option value="paused" ${st?.status === "paused" ? "selected" : ""}>Пауза</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>Стоимость занятия, ₽</label><input type="number" id="f-price" value="${st?.price ?? 1500}" /></div>
        <div class="field"><label>Длительность, мин</label><input type="number" id="f-duration" value="${st?.duration ?? 60}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Телефон родителя</label><input type="tel" id="f-phone" value="${escapeHTML(st?.phone || "")}" placeholder="+7 900 000-00-00" /></div>
        <div class="field"><label>Telegram</label><input type="text" id="f-telegram" value="${escapeHTML(st?.telegram || "")}" placeholder="@username" /></div>
      </div>
      <div class="field"><label>Комментарий</label><textarea id="f-comment" placeholder="Особенности, пожелания…">${escapeHTML(st?.comment || "")}</textarea></div>
      <button class="btn btn-primary" onclick="saveStudent(${isEdit ? `'${st.id}'` : "null"})">Сохранить</button>
    `);
    setTimeout(() => document.getElementById("f-name")?.focus(), 50);
  }

  window.saveStudent = async function (id) {
    const name = document.getElementById("f-name").value.trim();
    if (!name) { showToast("Введите имя ученика"); return; }
    const data = {
      name,
      grade: document.getElementById("f-grade").value.trim(),
      status: document.getElementById("f-status").value,
      price: Number(document.getElementById("f-price").value) || 0,
      duration: Number(document.getElementById("f-duration").value) || 60,
      phone: document.getElementById("f-phone").value.trim(),
      telegram: document.getElementById("f-telegram").value.trim(),
      comment: document.getElementById("f-comment").value.trim(),
    };
    await withGuard("saveStudent", async () => {
    if (id) {
      const ok = await dbUpdateStudent(id, data);
      if (!ok) return;
      Object.assign(getStudent(id), data);
      showToast("Изменения сохранены");
    } else {
      const created = await dbInsertStudent(data);
      if (!created) return;
      state.students.push(created);
      showToast("Ученик добавлен");
    }
    closeModal();
    render();
    });
  };

  /* ---------------------------------------------------------
     FINANCES VIEW
  --------------------------------------------------------- */
  function renderFinances() {
    const filter = state.finance.filter;
    const range = periodRange(filter === "day" ? "today" : filter);
    const incomeLessons = incomeLessonsInRange(range);
    const expenses = expensesInRange(range);
    const income = incomeLessons.reduce((s, l) => s + (l.price || 0), 0);
    const expenseSum = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const balance = income - expenseSum;

    return `
      <div class="segmented" style="margin-bottom:14px">
        <button class="${filter === "day" ? "active" : ""}" onclick="financeSetFilter('day')">День</button>
        <button class="${filter === "week" ? "active" : ""}" onclick="financeSetFilter('week')">Неделя</button>
        <button class="${filter === "month" ? "active" : ""}" onclick="financeSetFilter('month')">Месяц</button>
      </div>

      <div class="hero">
        <div class="hero-label">Баланс</div>
        <div class="hero-amount">${money(balance)}</div>
        <div class="hero-stats">
          <div class="hero-stat"><div class="n">${money(income)}</div><div class="l">доходы</div></div>
          <div class="hero-stat"><div class="n">${money(expenseSum)}</div><div class="l">расходы</div></div>
        </div>
      </div>

      <div class="card-title" style="margin-top:4px">Доходы</div>
      <div class="card" style="padding:6px 12px">
        ${incomeLessons.length === 0 ? emptyBlock("💰", "Доходов нет", "За выбранный период занятий не проведено") :
        incomeLessons.map((l) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${escapeHTML(getStudent(l.studentId)?.name || "Ученик")}</div>
              <div class="row-sub">${humanDate(l.date)} · ${l.time}</div>
            </div>
            <div class="row-amount" style="color:var(--success)">+${money(l.price)}</div>
          </div>`).join("")}
      </div>

      <div class="card-title" style="margin-top:16px">Расходы</div>
      <div class="card" style="padding:6px 12px">
        ${expenses.length === 0 ? emptyBlock("🧾", "Расходов нет", "Нажмите «+ Расход» вверху экрана") :
        expenses.map((e) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${escapeHTML(e.title)}</div>
              <div class="row-sub">${humanDate(e.date)}</div>
            </div>
            <div class="row-amount" style="color:var(--danger)">−${money(e.amount)}</div>
            <button class="btn-ghost" style="margin-left:6px" onclick="deleteExpense('${e.id}')">✕</button>
          </div>`).join("")}
      </div>
    `;
  }
  window.financeSetFilter = function (v) { state.finance.filter = v; render(); };

  window.openAddExpense = function () {
    openModal(`
      <div class="modal-header"><h2>Новый расход</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="field"><label>Название</label><input type="text" id="e-title" placeholder="Реклама, материалы…" /></div>
      <div class="field-row">
        <div class="field"><label>Сумма, ₽</label><input type="number" id="e-amount" placeholder="1000" /></div>
        <div class="field"><label>Дата</label><input type="date" id="e-date" value="${todayISO()}" /></div>
      </div>
      <button class="btn btn-primary" onclick="saveExpense()">Сохранить</button>
    `);
    setTimeout(() => document.getElementById("e-title")?.focus(), 50);
  };
  window.saveExpense = async function () {
    const title = document.getElementById("e-title").value.trim();
    const amount = Number(document.getElementById("e-amount").value) || 0;
    const date = document.getElementById("e-date").value || todayISO();
    if (!title || amount <= 0) { showToast("Заполните название и сумму"); return; }
    await withGuard("saveExpense", async () => {
      const created = await dbInsertExpense({ title, amount, date });
      if (!created) return;
      state.expenses.push(created);
      closeModal();
      showToast("Расход добавлен");
      render();
    });
  };
  window.deleteExpense = async function (id) {
    const ok = await dbDeleteExpense(id);
    if (!ok) return;
    state.expenses = state.expenses.filter((e) => e.id !== id);
    render();
  };

  /* ---------------------------------------------------------
     STATS VIEW
  --------------------------------------------------------- */
  function renderStats() {
    const period = state.stats.period;
    const s = statsForPeriod(period);
    const maxAmt = Math.max(1, ...s.trend.map((t) => t.amt));

    return `
      <div class="tabs-scroll">
        ${["today", "week", "month", "year"].map((p) => `
          <button class="pill-tab ${period === p ? "active" : ""}" onclick="statsSetPeriod('${p}')">
            ${{ today: "Сегодня", week: "Неделя", month: "Месяц", year: "Год" }[p]}
          </button>`).join("")}
      </div>

      <div class="stat-grid">
        <div class="stat-tile"><div class="v">${money(s.revenue)}</div><div class="l">Доход</div></div>
        <div class="stat-tile"><div class="v">${s.lessonsCount}</div><div class="l">Занятий проведено</div></div>
        <div class="stat-tile"><div class="v">${money(s.avgPrice)}</div><div class="l">Средний чек</div></div>
        <div class="stat-tile"><div class="v">${s.cancels}</div><div class="l">Отмен</div></div>
        <div class="stat-tile" style="grid-column:1/-1"><div class="v">${s.moved}</div><div class="l">Переносов</div></div>
      </div>

      <div class="card section-gap">
        <div class="card-title">Самый прибыльный ученик</div>
        ${s.topStudent ? `
          <div class="row" style="border:none">
            <div class="avatar">${initials(s.topStudent.name)}</div>
            <div class="row-main">
              <div class="row-title">${escapeHTML(s.topStudent.name)}</div>
              <div class="row-sub">за выбранный период</div>
            </div>
            <div class="row-amount">${money(s.topAmount)}</div>
          </div>` : emptyBlock("🏆", "Пока нет данных", "Появится после первых проведённых занятий")}
      </div>

      ${s.trend.length ? `
        <div class="card section-gap">
          <div class="card-title">Динамика дохода</div>
          <div class="bar-chart">
            ${s.trend.map((t) => `
              <div class="bar-wrap">
                <div class="bar" style="height:${Math.max(4, (t.amt / maxAmt) * 90)}px" title="${money(t.amt)}"></div>
                <div class="lbl">${t.label}</div>
              </div>`).join("")}
          </div>
        </div>` : ""}
    `;
  }
  window.statsSetPeriod = function (p) { state.stats.period = p; render(); };

  /* ---------------------------------------------------------
     ADD / EDIT LESSON (schedule) MODAL
  --------------------------------------------------------- */
  window.openAddLesson = function (dateISO) {
    if (!state.students.length) { showToast("Сначала добавьте ученика"); return; }
    renderLessonForm(null, dateISO);
  };
  window.openEditLesson = function (id) {
    renderLessonForm(state.lessons.find((l) => l.id === id));
  };

  function renderLessonForm(lesson, defaultDate) {
    const isEdit = !!lesson;
    const studentOptions = state.students.map((s) => `<option value="${s.id}" ${lesson?.studentId === s.id ? "selected" : ""}>${escapeHTML(s.name)}</option>`).join("");
    openModal(`
      <div class="modal-header"><h2>${isEdit ? "Занятие" : "Новое занятие"}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="field"><label>Ученик</label><select id="l-student">${studentOptions}</select></div>
      <div class="field-row">
        <div class="field"><label>Дата</label><input type="date" id="l-date" value="${lesson?.date || defaultDate || todayISO()}" /></div>
        <div class="field"><label>Время</label><input type="time" id="l-time" value="${lesson?.time || "16:00"}" /></div>
      </div>
      ${isEdit ? `
        <div class="field"><label>Статус</label>
          <select id="l-status">
            ${["planned", "done", "cancelled", "moved"].map((st) => `<option value="${st}" ${lesson.status === st ? "selected" : ""}>${STATUS_LABEL[st]}</option>`).join("")}
          </select>
        </div>
        <div class="toggle-row">
          <span class="label">Оплачено</span>
          <button class="switch ${lesson.paid ? "on" : ""}" id="l-paid-switch" onclick="this.classList.toggle('on')"></button>
        </div>
      ` : ""}
      <div class="field"><label>Домашнее задание</label><textarea id="l-homework" placeholder="Необязательно">${escapeHTML(lesson?.homework || "")}</textarea></div>
      <div class="field"><label>Комментарий</label><textarea id="l-comment" placeholder="Необязательно">${escapeHTML(lesson?.comment || "")}</textarea></div>
      <div class="btn-row">
        ${isEdit ? `<button class="btn btn-danger" onclick="deleteLesson('${lesson.id}')">Удалить</button>` : ""}
        <button class="btn btn-primary" onclick="saveLessonForm(${isEdit ? `'${lesson.id}'` : "null"})">Сохранить</button>
      </div>
    `);
  }

  window.saveLessonForm = async function (id) {
    const studentId = document.getElementById("l-student").value;
    const date = document.getElementById("l-date").value;
    const time = document.getElementById("l-time").value;
    const homework = document.getElementById("l-homework").value.trim();
    const comment = document.getElementById("l-comment").value.trim();
    const student = getStudent(studentId);
    if (!student) { showToast("Выберите ученика"); return; }

    await withGuard("saveLesson", async () => {
    if (id) {
      const l = state.lessons.find((x) => x.id === id);
      const statusEl = document.getElementById("l-status");
      const paidEl = document.getElementById("l-paid-switch");
      const merged = {
        ...l, studentId, date, time, homework, comment,
        status: statusEl ? statusEl.value : l.status,
        paid: paidEl ? paidEl.classList.contains("on") : l.paid,
      };
      const ok = await dbUpdateLesson(id, merged);
      if (!ok) return;
      Object.assign(l, merged);
      showToast("Занятие обновлено");
    } else {
      const created = await dbInsertLesson({
        studentId, date, time, homework, comment,
        status: "planned", paid: false, hwDone: false, price: student.price,
      });
      if (!created) return;
      state.lessons.push(created);
      showToast("Занятие добавлено в расписание");
    }
    closeModal();
    render();
    });
  };
  window.deleteLesson = async function (id) {
    if (!confirm("Удалить это занятие?")) return;
    const ok = await dbDeleteLesson(id);
    if (!ok) return;
    state.lessons = state.lessons.filter((l) => l.id !== id);
    closeModal();
    showToast("Занятие удалено");
    render();
  };

  /* ---------------------------------------------------------
     CONDUCT LESSON FLOW (main scenario)
  --------------------------------------------------------- */
  window.openConductLesson = function (presetStudentId) {
    state.conduct = { step: presetStudentId ? 2 : 1, studentId: presetStudentId || null, lessonId: null, status: null };
    if (presetStudentId) prepareConductLesson(presetStudentId);
    renderConductModal();
  };

  function prepareConductLesson(studentId) {
    const today = todayISO();
    const existing = state.lessons.find((l) => l.studentId === studentId && l.date === today && l.status === "planned");
    state.conduct.studentId = studentId;
    state.conduct.lessonId = existing ? existing.id : null;
    state.conduct.date = existing ? existing.date : today;
    state.conduct.time = existing ? existing.time : nowHHMM();
  }

  function renderConductModal() {
    const c = state.conduct;
    if (c.step === 1) {
      if (!state.students.length) {
        openModal(`<div class="modal-header"><h2>Провести занятие</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
          ${emptyBlock("👨‍🎓", "Сначала добавьте ученика", "Раздел «Ученики» → «+ Добавить»")}`);
        return;
      }
      openModal(`
        <div class="modal-header"><h2>Выберите ученика</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
        <input class="search-input" id="c-search" placeholder="Поиск…" oninput="conductFilterStudents(this.value)" />
        <div id="c-student-list">${conductStudentListHTML("")}</div>
      `);
      setTimeout(() => document.getElementById("c-search")?.focus(), 50);
      return;
    }
    if (c.step === 2) {
      const st = getStudent(c.studentId);
      openModal(`
        <div class="modal-header"><h2>${escapeHTML(st.name)}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="small muted" style="margin-bottom:14px">${humanDate(c.date)} · ${c.time}</div>
        <div class="card-title">Как прошло занятие?</div>
        <div class="option-grid">
          <button class="option-card" onclick="conductSetStatus('done')"><span class="ico">✅</span>Проведено</button>
          <button class="option-card" onclick="conductSetStatus('cancelled')"><span class="ico">🚫</span>Отменено</button>
          <button class="option-card" onclick="conductSetStatus('moved')"><span class="ico">🔁</span>Перенос</button>
        </div>
      `);
      return;
    }
    if (c.step === 3) {
      const st = getStudent(c.studentId);
      let extra = "";
      if (c.status === "done") {
        extra = `
          <div class="field-row">
            <div class="field"><label>Дата проведения</label><input type="date" id="c-done-date" value="${c.date}" /></div>
            <div class="field"><label>Время</label><input type="time" id="c-done-time" value="${c.time}" /></div>
          </div>
          <div class="toggle-row">
            <span class="label">Оплачено</span>
            <button class="switch ${c.paid ? "on" : ""}" id="c-paid-switch" onclick="this.classList.toggle('on')"></button>
          </div>
          <div class="field"><label>Домашнее задание</label><textarea id="c-homework" placeholder="Необязательно"></textarea></div>
          <div class="field"><label>Комментарий</label><textarea id="c-comment" placeholder="Необязательно"></textarea></div>`;
      } else if (c.status === "cancelled") {
        extra = `<div class="field"><label>Комментарий</label><textarea id="c-comment" placeholder="Причина отмены (необязательно)"></textarea></div>`;
      } else if (c.status === "moved") {
        extra = `
          <div class="field-row">
            <div class="field"><label>Новая дата</label><input type="date" id="c-move-date" value="${addDays(c.date, 1)}" /></div>
            <div class="field"><label>Новое время</label><input type="time" id="c-move-time" value="${c.time}" /></div>
          </div>
          <div class="field"><label>Комментарий</label><textarea id="c-comment" placeholder="Необязательно"></textarea></div>`;
      }
      openModal(`
        <div class="modal-header"><h2>${escapeHTML(st.name)}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="small muted" style="margin-bottom:14px">${STATUS_LABEL[c.status]} · ${money(st.price)}</div>
        ${extra}
        <div class="btn-row">
          <button class="btn btn-secondary" onclick="conductBack()">Назад</button>
          <button class="btn btn-primary" onclick="conductSave()">Сохранить</button>
        </div>
      `);
    }
  }

  function conductStudentListHTML(query) {
    const q = query.trim().toLowerCase();
    const list = state.students.filter((s) => s.name.toLowerCase().includes(q));
    if (!list.length) return emptyBlock("🔍", "Никого не нашли", "Попробуйте другой запрос");
    return list.map((s) => `
      <div class="row row-tap" onclick="conductPickStudent('${s.id}')">
        <div class="avatar">${initials(s.name)}</div>
        <div class="row-main">
          <div class="row-title">${escapeHTML(s.name)}</div>
          <div class="row-sub">${escapeHTML(s.grade || "—")} · ${money(s.price)}</div>
        </div>
        <span class="chev">›</span>
      </div>`).join("");
  }
  window.conductFilterStudents = function (v) {
    document.getElementById("c-student-list").innerHTML = conductStudentListHTML(v);
  };
  window.conductPickStudent = function (id) {
    prepareConductLesson(id);
    state.conduct.step = 2;
    renderConductModal();
  };
  window.conductSetStatus = function (status) {
    state.conduct.status = status;
    state.conduct.paid = false;
    state.conduct.step = 3;
    renderConductModal();
  };
  window.conductBack = function () {
    state.conduct.step = 2;
    renderConductModal();
  };
  window.conductSave = async function () {
    const c = state.conduct;
    const student = getStudent(c.studentId);
    const comment = document.getElementById("c-comment")?.value.trim() || "";

    let payload = { status: c.status, comment };
    if (c.status === "done") {
      payload.paid = document.getElementById("c-paid-switch")?.classList.contains("on") || false;
      payload.homework = document.getElementById("c-homework")?.value.trim() || "";
      payload.date = document.getElementById("c-done-date").value;
      payload.time = document.getElementById("c-done-time").value;
    } else if (c.status === "moved") {
      payload.date = document.getElementById("c-move-date").value;
      payload.time = document.getElementById("c-move-time").value;
    }

    await withGuard("conductSave", async () => {
    if (c.lessonId) {
      const l = state.lessons.find((x) => x.id === c.lessonId);
      const merged = { ...l, ...payload };
      if (c.status === "cancelled") { merged.date = c.date; merged.time = c.time; }
      const ok = await dbUpdateLesson(c.lessonId, merged);
      if (!ok) return;
      Object.assign(l, merged);
    } else {
      const newData = {
        studentId: c.studentId,
        date: c.date, time: c.time,
        price: student.price, hwDone: false, homework: "", paid: false, comment: "",
        ...payload,
      };
      const created = await dbInsertLesson(newData);
      if (!created) return;
      state.lessons.push(created);
    }
    closeModal();
    state.conduct = null;
    showToast("Занятие сохранено");
    render();
    });
  };

  /* ---------------------------------------------------------
     INIT
  --------------------------------------------------------- */
  async function init() {
    ensureScheduleInit();
    if (CONFIG_MISSING) { render(); return; }

    sbClient.auth.onAuthStateChange((event, session) => {
      state.session = session;
      if (event === "PASSWORD_RECOVERY") { state.authMode = "reset"; render(); return; }
      // Важно: НЕ делать supabase-запросы напрямую внутри этого колбэка —
      // это может подвесить внутреннюю блокировку авторизации в supabase-js.
      // Поэтому выносим дальнейшую загрузку данных за пределы колбэка.
      setTimeout(async () => {
        if (session) {
          const { error: bootErr } = await sbClient.rpc("bootstrap_individual_tutor");
          if (bootErr) { console.error(bootErr); showToast("Не удалось подготовить кабинет"); }
          await dbFetchAll();
        }
        else { state.students = []; state.lessons = []; state.expenses = []; }
        render();
      }, 0);
    });
  }
  init();
})();
