/* ===========================================================
   Моя школа CRM — приложение для репетитора
   Vanilla JS, без сборки. Данные хранятся в Supabase (Postgres).
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
      createdAt: r.created_at, parentCode: r.parent_code,
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
      homeworkFileUrl: r.homework_file_url, submissionFileUrl: r.submission_file_url,
      submissionComment: r.submission_comment,
      boardLink: r.board_link, meetingLink: r.meeting_link, duration: r.duration,
    };
  }
  function lessonToRow(l) {
    return {
      student_id: l.studentId, date: l.date, time: l.time, status: l.status,
      paid: !!l.paid, homework: l.homework || "", hw_done: !!l.hwDone,
      comment: l.comment || "", price: l.price,
      homework_file_url: l.homeworkFileUrl || null, submission_file_url: l.submissionFileUrl || null,
      submission_comment: l.submissionComment || "",
      board_link: l.boardLink || null, meeting_link: l.meetingLink || null,
      duration: l.duration || 60,
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

  // Загрузка данных для роли «родитель»: свои дети (через собственные
  // parents-записи) и их занятия — только на чтение.
  async function dbFetchAllParent() {
    const mySeq = ++fetchSeq;
    const parentsRes = await sbClient.from("parents").select("id");
    const parentIds = (parentsRes.data || []).map((p) => p.id);
    let studentsData = [], lessonsData = [];
    if (parentIds.length) {
      const studentsRes = await sbClient.from("students").select("*").in("parent_id", parentIds).order("name");
      studentsData = studentsRes.data || [];
      const studentIds = studentsData.map((s) => s.id);
      if (studentIds.length) {
        const lessonsRes = await sbClient.from("lessons").select("*").in("student_id", studentIds);
        lessonsData = lessonsRes.data || [];
      }
    }
    if (mySeq !== fetchSeq) return;
    state.parentChildren = studentsData.map(studentFromRow);
    state.parentLessons = lessonsData.map(lessonFromRow);
  }

  // Загрузка данных для роли «ученик»: своя карточка и свои занятия.
  async function dbFetchAllStudent() {
    const mySeq = ++fetchSeq;
    const meRes = await sbClient.from("students").select("*").eq("user_id", state.session.user.id).limit(1);
    const me = (meRes.data || [])[0] || null;
    let lessonsData = [];
    if (me) {
      const lessonsRes = await sbClient.from("lessons").select("*").eq("student_id", me.id);
      lessonsData = lessonsRes.data || [];
    }
    if (mySeq !== fetchSeq) return;
    state.studentSelf = me ? studentFromRow(me) : null;
    state.studentLessons = lessonsData.map(lessonFromRow);
  }

  // Загружает профиль (имя + фото) — общий для всех ролей.
  async function fetchProfile() {
    const { data } = await sbClient.from("user_profiles").select("*").eq("user_id", state.session.user.id).maybeSingle();
    state.profile = {
      fullName: data?.full_name || "",
      lastName: data?.last_name || "",
      avatarUrl: data?.avatar_url || "",
      notifyPrefs: data?.notify_prefs || { lesson_reminder: true, payment_due: true, reschedule: true },
    };
  }

  async function saveProfileRow(patch) {
    const { error } = await sbClient.from("user_profiles").upsert({
      user_id: state.session.user.id,
      full_name: state.profile.fullName || null,
      last_name: state.profile.lastName || null,
      avatar_url: state.profile.avatarUrl || null,
      notify_prefs: state.profile.notifyPrefs,
      updated_at: new Date().toISOString(),
      ...patch,
    });
    return !error ? true : (console.error(error), false);
  }

  // Определяет роль текущего пользователя (репетитор/родитель/ученик) и
  // подгружает соответствующие данные. Безопасно вызывать повторно.
  async function finishRoleLoad(role, dataLoader) {
    state.role = role;
    await dataLoader();
    await fetchNotifications();
    await fetchFreeSlots();
    if (role === "tutor") await fetchPendingRequests();
  }

  async function loadForCurrentRole() {
    await fetchProfile();
    const myId = state.session.user.id;
    const tutorRes = await sbClient.from("tutors").select("id").eq("user_id", myId).limit(1);
    if (tutorRes.data && tutorRes.data.length) { await finishRoleLoad("tutor", dbFetchAll); return; }
    const parentRes = await sbClient.from("parents").select("id").eq("user_id", myId).limit(1);
    if (parentRes.data && parentRes.data.length) { await finishRoleLoad("parent", dbFetchAllParent); return; }
    const studentRes = await sbClient.from("students").select("id").eq("user_id", myId).limit(1);
    if (studentRes.data && studentRes.data.length) { await finishRoleLoad("student", dbFetchAllStudent); return; }

    // Никакая роль не найдена — вероятно, регистрация была прервана
    // подтверждением почты до того, как выполнился бутстрап/привязка по
    // коду. Догоняем это здесь же, после перехода по ссылке из письма.
    const pendingRaw = localStorage.getItem("noschool_pending_signup");
    if (pendingRaw) {
      localStorage.removeItem("noschool_pending_signup");
      try {
        const pending = JSON.parse(pendingRaw);
        if (pending.role === "parent" && pending.code) {
          const { error } = await sbClient.rpc("link_parent_to_child", { p_code: pending.code });
          if (error) showToast("Код не найден. Войдите и добавьте по коду вручную.");
        } else if (pending.role === "student" && pending.code) {
          const { error } = await sbClient.rpc("link_student_to_record", { p_code: pending.code });
          if (error) showToast("Код не найден. Войдите и добавьте по коду вручную.");
        } else {
          await sbClient.rpc("bootstrap_individual_tutor");
        }
        const retryTutor = await sbClient.from("tutors").select("id").eq("user_id", myId).limit(1);
        if (retryTutor.data && retryTutor.data.length) { await finishRoleLoad("tutor", dbFetchAll); return; }
        const retryParent = await sbClient.from("parents").select("id").eq("user_id", myId).limit(1);
        if (retryParent.data && retryParent.data.length) { await finishRoleLoad("parent", dbFetchAllParent); return; }
        const retryStudent = await sbClient.from("students").select("id").eq("user_id", myId).limit(1);
        if (retryStudent.data && retryStudent.data.length) { await finishRoleLoad("student", dbFetchAllStudent); return; }
      } catch (e) { console.error(e); }
    }
    state.role = null; // ещё не настроено (не должно случаться в норме)
  }

  function resetAllState() {
    state.role = null;
    state.profile = { fullName: "", avatarUrl: "" };
    state.students = []; state.lessons = []; state.expenses = [];
    state.parentChildren = []; state.parentLessons = [];
    state.studentSelf = null; state.studentLessons = [];
    state.notifications = []; state.freeSlots = []; state.pendingRequests = [];
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

  // Загружает файл (ДЗ репетитора или решение ученика) в общий бакет
  // lesson-files и возвращает публичную ссылку, либо null при ошибке.
  async function uploadLessonFile(lessonId, kind, file) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${lessonId}/${kind}-${Date.now()}.${ext}`;
    const { error } = await sbClient.storage.from("lesson-files").upload(path, file, { upsert: true, cacheControl: "3600" });
    if (error) { console.error(error); showToast("Не удалось загрузить файл"); return null; }
    const { data: pub } = sbClient.storage.from("lesson-files").getPublicUrl(path);
    return pub.publicUrl;
  }

  // Отчёт по занятию хранится отдельно от lessons — так его можно
  // спрятать от ученика на уровне прав доступа (RLS), а не только в UI.
  async function saveLessonReport(lessonId, text) {
    const { error } = await sbClient.from("lesson_reports")
      .upsert({ lesson_id: lessonId, what_covered: text }, { onConflict: "lesson_id" });
    if (error) { console.error(error); showToast("Отчёт не сохранился"); return false; }
    return true;
  }

  /* ---------------------------------------------------------
     УВЕДОМЛЕНИЯ
  --------------------------------------------------------- */
  async function createNotification(userId, type, message) {
    if (!userId) return;
    const { error } = await sbClient.from("notifications").insert({ user_id: userId, type, message });
    if (error) console.error(error);
  }
  async function fetchNotifications() {
    const { data } = await sbClient.from("notifications").select("*").order("created_at", { ascending: false }).limit(50);
    state.notifications = data || [];
  }
  function unreadNotificationsCount() {
    return state.notifications.filter((n) => !n.read_status).length;
  }

  /* ---------------------------------------------------------
     СВОБОДНЫЕ ОКНА
  --------------------------------------------------------- */
  async function fetchFreeSlots() {
    const { data } = await sbClient.from("free_slots").select("*").order("weekday");
    state.freeSlots = data || [];
  }
  async function dbInsertFreeSlot(weekday, startTime, endTime) {
    const { data, error } = await sbClient.from("free_slots").insert({ weekday, start_time: startTime, end_time: endTime }).select().single();
    if (error) { console.error(error); showToast("Не удалось добавить окно"); return null; }
    return data;
  }
  async function dbDeleteFreeSlot(id) {
    const { error } = await sbClient.from("free_slots").delete().eq("id", id);
    if (error) { console.error(error); showToast("Не удалось удалить"); return false; }
    return true;
  }

  /* ---------------------------------------------------------
     ЗАПРОСЫ НА ПЕРЕНОС / ОТМЕНУ
  --------------------------------------------------------- */
  async function fetchPendingRequests() {
    const { data } = await sbClient.from("lesson_change_requests").select("*").eq("status", "pending").order("created_at");
    state.pendingRequests = data || [];
  }

  function upcomingFreeSlotOptions(daysAhead) {
    const today = todayISO();
    const options = [];
    for (let i = 1; i <= daysAhead; i++) {
      const d = addDays(today, i);
      const wd = (dateFromISO(d).getDay() + 6) % 7;
      state.freeSlots.filter((s) => s.weekday === wd).forEach((s) => {
        options.push({ date: d, time: s.start_time.slice(0, 5) });
      });
    }
    return options;
  }

  window.openRequestsModal = async function () {
    await fetchPendingRequests();
    const rows = state.pendingRequests.map((r) => {
      const l = state.lessons.find((x) => x.id === r.lesson_id);
      const st = l ? getStudent(l.studentId) : null;
      const roleLabel = r.requested_by_role === "parent" ? "Родитель" : "Ученик";
      return `
        <div class="card" style="margin-bottom:10px">
          <div style="font-weight:700">${escapeHTML(st?.name || "Ученик")}</div>
          <div class="small muted" style="margin-bottom:6px">${roleLabel} просит ${r.type === "cancel" ? "отменить" : "перенести"} занятие ${l ? humanDate(l.date) + " · " + l.time : ""}</div>
          ${r.type === "reschedule" ? `<div class="small" style="margin-bottom:6px">Новое время: <b>${humanDate(r.new_date)}, ${r.new_time?.slice(0, 5)}</b></div>` : ""}
          ${r.reason ? `<div class="small muted" style="margin-bottom:6px">«${escapeHTML(r.reason)}»</div>` : ""}
          <div class="btn-row">
            <button class="btn btn-secondary" onclick="resolveRequest('${r.id}', 'rejected')">Отклонить</button>
            <button class="btn btn-primary" onclick="resolveRequest('${r.id}', 'approved')">Подтвердить</button>
          </div>
        </div>`;
    }).join("");
    openModal(`
      <div class="modal-header"><h2>Запросы</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      ${rows || emptyBlock("📨", "Запросов нет", "Здесь появятся запросы на перенос или отмену")}
    `);
  };

  window.resolveRequest = async function (requestId, decision) {
    const r = state.pendingRequests.find((x) => x.id === requestId);
    if (!r) return;
    const l = state.lessons.find((x) => x.id === r.lesson_id);
    if (decision === "approved" && l) {
      let ok = true;
      if (r.type === "cancel") {
        ok = await dbUpdateLesson(l.id, { ...l, status: "cancelled", comment: r.reason || l.comment });
        if (ok) l.status = "cancelled";
      } else if (r.type === "reschedule") {
        ok = await dbUpdateLesson(l.id, { ...l, date: r.new_date, time: r.new_time.slice(0, 5) });
        if (ok) { l.date = r.new_date; l.time = r.new_time.slice(0, 5); }
      }
      if (!ok) return;
    }
    const { error } = await sbClient.from("lesson_change_requests")
      .update({ status: decision, resolved_by: state.session.user.id, resolved_at: new Date().toISOString() })
      .eq("id", requestId);
    if (error) { console.error(error); showToast("Не удалось сохранить решение"); return; }
    state.pendingRequests = state.pendingRequests.filter((x) => x.id !== requestId);
    const verb = r.type === "cancel" ? "отмену" : "перенос";
    await createNotification(r.requested_by, "reschedule",
      decision === "approved" ? `Репетитор подтвердил ${verb} занятия` : `Репетитор отклонил запрос на ${verb} занятия`);
    showToast(decision === "approved" ? "Подтверждено" : "Отклонено");
    closeModal();
    render();
  };

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
    authRole: "tutor", // выбор роли на экране регистрации: tutor | parent | student
    role: null, // фактическая роль после входа: tutor | parent | student
    profile: { fullName: "", avatarUrl: "" },
    students: [],
    lessons: [],
    expenses: [],
    parentChildren: [],
    parentLessons: [],
    studentSelf: null,
    studentLessons: [],
    notifications: [],
    freeSlots: [],
    pendingRequests: [],
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
  function startOfMonthISO(iso) {
    const d = dateFromISO(iso);
    return isoFromDate(new Date(d.getFullYear(), d.getMonth(), 1));
  }
  function addMonths(iso, n) {
    const d = dateFromISO(iso);
    return isoFromDate(new Date(d.getFullYear(), d.getMonth() + n, 1));
  }
  function monthGridDates(monthStartIso) {
    const d = dateFromISO(monthStartIso);
    const lastOfMonthIso = isoFromDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    const gridStart = startOfWeekISO(monthStartIso);
    const gridEnd = addDays(startOfWeekISO(lastOfMonthIso), 6);
    const dates = [];
    for (let cur = gridStart; cur <= gridEnd; cur = addDays(cur, 1)) dates.push(cur);
    return dates;
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

  // Ищет пересечение по времени с уже существующим занятием того же
  // репетитора в этот день (кроме отменённых и кроме самого себя при
  // редактировании).
  function findLessonConflict(date, time, durationMin, excludeId) {
    const startTs = combineTS(date, time);
    const endTs = startTs + (durationMin || 60) * 60000;
    return state.lessons.find((l) => {
      if (l.id === excludeId) return false;
      if (l.date !== date) return false;
      if (l.status === "cancelled") return false;
      const lStart = combineTS(l.date, l.time);
      const lEnd = lStart + (l.duration || 60) * 60000;
      return startTs < lEnd && endTs > lStart;
    });
  }

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
    if (!state.schedule.monthStart) state.schedule.monthStart = startOfMonthISO(state.schedule.selectedDate);
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

  window.pickDurationChip = function (btn, chipsId, inputId) {
    chipsId = chipsId || "l-duration-chips";
    inputId = inputId || "l-duration";
    document.querySelectorAll(`#${chipsId} .chip`).forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(inputId).value = btn.dataset.min;
  };

  window.copyInviteCode = async function (code) {
    try {
      await navigator.clipboard.writeText(code);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = code; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e2) { /* noop */ }
      document.body.removeChild(ta);
    }
    showToast("Код скопирован");
  };

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
    if (state.role === "parent") { app.innerHTML = renderParentApp(); return; }
    if (state.role === "student") { app.innerHTML = renderStudentApp(); return; }
    if (state.role !== "tutor") {
      app.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center"><div class="muted">Загрузка…</div></div>`;
      return;
    }
    app.innerHTML = `${renderTopbar()}<div class="view">${renderView()}</div>${renderBottomNav()}`;
    if (state.view === "schedule" && (state.schedule.mode === "day" || state.schedule.mode === "week")) {
      const wrap = document.querySelector(".day-timeline-wrap, .week-grid-wrap");
      if (wrap) wrap.scrollTop = 7 * HOUR_PX; // не начинаем день с полуночи
    }
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
    const role = state.authRole;
    return `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
        <div class="card" style="width:100%;max-width:360px">
          <div style="text-align:center;margin-bottom:18px">
            <img src="icons/icon-192.png" alt="Моя школа" style="height:52px;width:52px;border-radius:14px;margin:0 auto 8px;display:block" />
            <div style="font-size:26px;font-weight:700;font-family:var(--font-display)">Моя школа</div>
            <div class="muted small">${mode === "signin" ? "Вход в CRM" : "Регистрация"}</div>
          </div>
          ${mode === "signup" ? `
            <div class="segmented" style="margin-bottom:14px">
              <button class="${role === "tutor" ? "active" : ""}" onclick="authSetRole('tutor')">Репетитор</button>
              <button class="${role === "parent" ? "active" : ""}" onclick="authSetRole('parent')">Родитель</button>
              <button class="${role === "student" ? "active" : ""}" onclick="authSetRole('student')">Ученик</button>
            </div>
          ` : ""}
          <div class="field"><label>Email</label><input type="text" id="auth-email" placeholder="you@example.com" autocomplete="username" /></div>
          <div class="field"><label>Пароль</label><input type="password" id="auth-password" placeholder="Минимум 6 символов" autocomplete="current-password" /></div>
          ${mode === "signup" && (role === "parent" || role === "student") ? `
            <div class="field"><label>Код от репетитора</label><input type="text" id="auth-parent-code" placeholder="Например, a1b2c3" /></div>
          ` : ""}
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

  window.authSetRole = function (r) { state.authRole = r; render(); };

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
    const role = state.authRole;
    const needsCode = role === "parent" || role === "student";
    const inviteCode = needsCode ? document.getElementById("auth-parent-code").value.trim() : null;
    if (needsCode && !inviteCode) { authSetError("Введите код, который дал репетитор"); return; }
    const btn = document.getElementById("auth-submit"); btn.disabled = true;
    localStorage.setItem("noschool_pending_signup", JSON.stringify({ role, code: inviteCode }));
    const siteUrl = window.location.href.split("#")[0].split("?")[0];
    const { data, error } = await sbClient.auth.signUp({
      email, password,
      options: { emailRedirectTo: siteUrl },
    });
    if (error) { authSetError(error.message); btn.disabled = false; return; }
    if (!data.session) {
      state.authMode = "signin";
      render();
      authSetError("Проверьте почту и подтвердите регистрацию, затем войдите", true);
      return;
    }
    localStorage.removeItem("noschool_pending_signup");
    if (role === "parent") {
      const { error: linkErr } = await sbClient.rpc("link_parent_to_child", { p_code: inviteCode });
      if (linkErr) { authSetError("Код не найден. Проверьте код у репетитора."); btn.disabled = false; return; }
    } else if (role === "student") {
      const { error: linkErr } = await sbClient.rpc("link_student_to_record", { p_code: inviteCode });
      if (linkErr) { authSetError("Код не найден. Проверьте код у репетитора."); btn.disabled = false; return; }
    } else {
      await sbClient.rpc("bootstrap_individual_tutor");
    }
    await loadForCurrentRole();
    render();
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
            <img src="icons/icon-192.png" alt="Моя школа" style="height:52px;width:52px;border-radius:14px;margin:0 auto 8px;display:block" />
            <div style="font-size:26px;font-weight:700;font-family:var(--font-display)">Моя школа</div>
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
    await loadForCurrentRole();
    render();
  };
  window.authSignOut = async function () {
    await sbClient.auth.signOut();
    state.session = null;
    resetAllState();
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
        <div style="display:flex;align-items:flex-start;justify-content:space-between">
          <div>
            <div class="eyebrow">${weekdayFull(d)}, ${humanDate(d)}</div>
            <h1>Моя школа</h1>
          </div>
          ${profileButtonHTML()}
        </div>
      </div>`;
    }
    if (state.view === "studentDetail") {
      const st = getStudent(state.studentDetail.id);
      return `<div class="topbar">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <button class="back" onclick="goTo('students')">‹ Ученики</button>
          ${profileButtonHTML()}
        </div>
        <h1>${escapeHTML(st ? st.name : "Ученик")}</h1>
      </div>`;
    }
    const title = TOPBAR_TITLES[state.view] || "";
    let action = "";
    if (state.view === "students") action = `<button class="back" style="color:var(--ink)" onclick="openAddStudent()">+ Добавить</button>`;
    if (state.view === "schedule") action = `<button class="back" style="color:var(--ink);margin-right:8px" onclick="openAddRecurring()">🔁</button><button class="back" style="color:var(--ink)" onclick="openAddLesson(state_scheduleDate())">+ Занятие</button>`;
    if (state.view === "finances") action = `<button class="back" style="color:var(--ink)" onclick="openAddExpense()">+ Расход</button>`;
    return `<div class="topbar">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h1 style="margin:0">${title}</h1>
        <div style="display:flex;align-items:center;gap:10px">
          ${action}
          ${profileButtonHTML()}
        </div>
      </div>
    </div>`;
  }
  window.state_scheduleDate = function () { ensureScheduleInit(); return state.schedule.selectedDate; };

  /* ---------------------------------------------------------
     PROFILE (общий для всех ролей: имя, фото, смена пароля)
  --------------------------------------------------------- */
  function profileInitial() {
    const name = state.profile.fullName || state.session?.user?.email || "?";
    return (name.trim()[0] || "?").toUpperCase();
  }
  function profileButtonHTML() {
    const url = state.profile.avatarUrl;
    const bg = url
      ? `background-image:url('${url}');background-size:cover;background-position:center;`
      : `background:var(--accent-soft);`;
    const unread = unreadNotificationsCount();
    return `<div style="display:flex;align-items:center;gap:8px">
      <button class="profile-btn" style="background:var(--surface-2);position:relative" onclick="openNotificationsModal()" aria-label="Уведомления">
        🔔${unread > 0 ? `<span class="notif-badge">${unread > 9 ? "9+" : unread}</span>` : ""}
      </button>
      <button class="profile-btn" style="${bg}" onclick="openProfileModal()" aria-label="Профиль">${url ? "" : escapeHTML(profileInitial())}</button>
    </div>`;
  }

  window.openNotificationsModal = async function () {
    await fetchNotifications();
    const list = state.notifications;
    const actionable = list.filter((n) => n.type === "request");
    const info = list.filter((n) => n.type !== "request");

    function notifRow(n) {
      return `
        <div class="row" style="border:none;padding:10px 4px;${n.read_status ? "opacity:0.6" : ""}">
          <div class="row-main">
            <div class="row-title" style="font-size:14px">${escapeHTML(n.message)}</div>
            <div class="row-sub">${humanDateYear(n.created_at.slice(0, 10))}</div>
          </div>
          ${!n.read_status ? `<span class="badge accent">новое</span>` : ""}
        </div>`;
    }

    openModal(`
      <div class="modal-header"><h2>Уведомления</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      ${list.length === 0 ? emptyBlock("🔔", "Пока пусто", "Здесь будут появляться события") : `
        ${actionable.length ? `
          <div class="card-title">Требуют действия</div>
          <div class="card" style="padding:2px 12px;margin-bottom:14px">${actionable.map(notifRow).join("")}</div>
          <button class="btn btn-primary" style="width:100%;margin-bottom:16px" onclick="closeModal(); openRequestsModal()">Открыть запросы</button>
        ` : ""}
        ${info.length ? `
          <div class="card-title">Информационные</div>
          <div class="card" style="padding:2px 12px">${info.map(notifRow).join("")}</div>
        ` : ""}
      `}
    `);
    const unreadIds = list.filter((n) => !n.read_status).map((n) => n.id);
    if (unreadIds.length) {
      await sbClient.from("notifications").update({ read_status: true }).in("id", unreadIds);
      state.notifications.forEach((n) => { n.read_status = true; });
      render();
    }
  };

  window.openProfileModal = function () {
    const roleLabel = { tutor: "Репетитор", parent: "Родитель", student: "Ученик" }[state.role] || "";
    const url = state.profile.avatarUrl;
    openModal(`
      <div class="modal-header"><h2>Профиль</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div style="display:flex;flex-direction:column;align-items:center;margin-bottom:18px">
        <label for="avatar-input" style="cursor:pointer">
          <div class="profile-avatar-lg" style="${url ? `background-image:url('${url}');background-size:cover;background-position:center;` : ""}">
            ${url ? "" : escapeHTML(profileInitial())}
          </div>
          <div class="small" style="text-align:center;color:var(--accent-ink);margin-top:8px;font-weight:600">Изменить фото</div>
        </label>
        <input type="file" id="avatar-input" accept="image/*" style="display:none" onchange="onAvatarSelected(this)" />
      </div>
      <div class="field-row">
        <div class="field"><label>Имя</label><input type="text" id="profile-name" value="${escapeHTML(state.profile.fullName || "")}" placeholder="Имя" /></div>
        <div class="field"><label>Фамилия</label><input type="text" id="profile-lastname" value="${escapeHTML(state.profile.lastName || "")}" placeholder="Фамилия" /></div>
      </div>
      <div class="field"><label>Логин</label><input type="text" value="${escapeHTML(state.session?.user?.email || "")}" disabled style="opacity:0.6" /></div>
      <div class="small muted" style="margin-bottom:14px">Роль: ${roleLabel}</div>
      <button class="btn btn-primary" onclick="saveProfileInfo()">Сохранить</button>

      <div class="card-title section-gap">Сменить пароль</div>
      <div class="field"><input type="password" id="profile-new-password" placeholder="Новый пароль, минимум 6 символов" /></div>
      <button class="btn btn-secondary" onclick="changePasswordFromProfile()">Обновить пароль</button>

      <button class="btn btn-ghost" style="width:100%;margin-top:16px" onclick="closeModal(); openSettings()">⚙️ Настройки</button>
      <button class="link-danger" style="display:block;margin:10px auto 0" onclick="closeModal(); authSignOut()">Выйти из аккаунта</button>
    `);
  };

  window.onAvatarSelected = async function (input) {
    const file = input.files && input.files[0];
    if (!file) return;
    showToast("Загружаем фото…");
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${state.session.user.id}/avatar.${ext}`;
    const { error: upErr } = await sbClient.storage.from("avatars").upload(path, file, { upsert: true, cacheControl: "3600" });
    if (upErr) { console.error(upErr); showToast("Не удалось загрузить фото"); return; }
    const { data: pub } = sbClient.storage.from("avatars").getPublicUrl(path);
    const avatarUrl = pub.publicUrl + "?t=" + Date.now();
    state.profile.avatarUrl = avatarUrl;
    const ok = await saveProfileRow({ avatar_url: avatarUrl });
    if (!ok) { showToast("Фото загружено, но не сохранилось в профиле"); return; }
    showToast("Фото обновлено");
    closeModal();
    render();
  };

  window.saveProfileInfo = async function () {
    state.profile.fullName = document.getElementById("profile-name").value.trim();
    state.profile.lastName = document.getElementById("profile-lastname").value.trim();
    const ok = await saveProfileRow({});
    if (!ok) { showToast("Не удалось сохранить"); return; }
    showToast("Профиль обновлён");
    closeModal();
    render();
  };

  window.changePasswordFromProfile = async function () {
    const pw = document.getElementById("profile-new-password").value;
    if (pw.length < 6) { showToast("Минимум 6 символов"); return; }
    const { error } = await sbClient.auth.updateUser({ password: pw });
    if (error) { showToast(error.message); return; }
    showToast("Пароль обновлён");
    closeModal();
  };

  /* ---------------------------------------------------------
     SETTINGS (доступны из профиля, общие для всех ролей;
     «О себе» — только у репетитора)
  --------------------------------------------------------- */
  window.openSettings = async function () {
    let bioSection = "";
    if (state.role === "tutor") {
      if (!state.tutorBio) {
        const { data } = await sbClient.from("tutors").select("description, subjects").limit(1).maybeSingle();
        state.tutorBio = { description: data?.description || "", subjects: (data?.subjects || []).join(", ") };
      }
      bioSection = `
        <div class="card-title">О себе (видно родителям и ученикам)</div>
        <div class="field"><label>Описание</label><textarea id="settings-bio" placeholder="Коротко о себе, опыте, подходе к занятиям">${escapeHTML(state.tutorBio.description)}</textarea></div>
        <div class="field"><label>Предметы (через запятую)</label><input type="text" id="settings-subjects" value="${escapeHTML(state.tutorBio.subjects)}" placeholder="Математика, физика" /></div>
        <button class="btn btn-secondary" onclick="saveTutorBio()">Сохранить «О себе»</button>
        <div class="small muted" style="margin-top:10px">Свободные окна теперь создаются прямо в Расписании — нажмите на пустую ячейку в календаре.</div>
      `;
    }
    const np = state.profile.notifyPrefs || {};
    openModal(`
      <div class="modal-header"><h2>Настройки</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      ${bioSection}
      <div class="card-title section-gap">Уведомления</div>
      <div class="toggle-row">
        <span class="label">Напоминания о занятиях</span>
        <button class="switch ${np.lesson_reminder ? "on" : ""}" id="notif-lesson" onclick="this.classList.toggle('on')"></button>
      </div>
      <div class="toggle-row">
        <span class="label">Об оплате</span>
        <button class="switch ${np.payment_due ? "on" : ""}" id="notif-payment" onclick="this.classList.toggle('on')"></button>
      </div>
      <div class="toggle-row">
        <span class="label">О переносах и отменах</span>
        <button class="switch ${np.reschedule ? "on" : ""}" id="notif-reschedule" onclick="this.classList.toggle('on')"></button>
      </div>
      <div class="small muted" style="margin-top:6px">Уведомления о переносах/отменах приходят по факту события. Регулярные напоминания «занятие скоро» и «пора оплатить» — по расписанию — появятся отдельно.</div>
      <button class="btn btn-secondary" style="width:100%;margin-top:10px" onclick="enablePushNotifications()">🔔 Включить уведомления на устройство</button>
      <button class="btn btn-ghost" style="width:100%" onclick="openPushDiagnostics()">🩺 Диагностика уведомлений</button>
      <button class="btn btn-primary" style="margin-top:10px" onclick="saveNotifyPrefs()">Сохранить настройки</button>

      <div class="card-title section-gap" style="color:var(--danger)">Опасная зона</div>
      <div class="small muted" style="margin-bottom:10px">
        ${state.role === "tutor"
          ? "Удаление аккаунта удалит вообще всё: всех учеников, все занятия и финансы. Восстановить будет нельзя."
          : "Аккаунт и привязка к репетитору будут удалены безвозвратно."}
      </div>
      <button class="btn btn-danger" style="width:100%" onclick="deleteMyAccount()">Удалить аккаунт</button>
    `);
  };

  window.addFreeSlot = async function () {
    const weekday = Number(document.getElementById("fs-weekday").value);
    const start = document.getElementById("fs-start").value;
    const end = document.getElementById("fs-end").value;
    if (end <= start) { showToast("Время окончания должно быть позже начала"); return; }
    const created = await dbInsertFreeSlot(weekday, start, end);
    if (!created) return;
    state.freeSlots.push(created);
    state.freeSlots.sort((a, b) => a.weekday - b.weekday);
    showToast("Окно добавлено");
    openSettings();
  };
  window.removeFreeSlot = async function (id) {
    const ok = await dbDeleteFreeSlot(id);
    if (!ok) return;
    state.freeSlots = state.freeSlots.filter((s) => s.id !== id);
    showToast("Окно удалено");
    openSettings();
  };

  window.saveTutorBio = async function () {
    const description = document.getElementById("settings-bio").value.trim();
    const subjects = document.getElementById("settings-subjects").value.split(",").map((s) => s.trim()).filter(Boolean);
    const { error } = await sbClient.from("tutors").update({ description, subjects }).eq("user_id", state.session.user.id);
    if (error) { console.error(error); showToast("Не удалось сохранить"); return; }
    state.tutorBio = { description, subjects: subjects.join(", ") };
    showToast("Сохранено");
  };

  window.deleteMyAccount = async function () {
    const warning = state.role === "tutor"
      ? "Вы репетитор — вместе с аккаунтом удалятся ВСЕ ваши ученики, занятия и финансы. Это необратимо."
      : "Аккаунт и привязка к репетитору будут удалены безвозвратно.";
    if (!confirm(`${warning}\n\nТочно удалить аккаунт?`)) return;
    if (!confirm("Последнее подтверждение: аккаунт будет удалён без возможности восстановления. Продолжить?")) return;
    const { error } = await sbClient.rpc("delete_own_account");
    if (error) { console.error(error); showToast("Не удалось удалить аккаунт"); return; }
    await sbClient.auth.signOut();
    state.session = null;
    resetAllState();
    closeModal();
    showToast("Аккаунт удалён");
    render();
  };

  window.saveNotifyPrefs = async function () {
    state.profile.notifyPrefs = {
      lesson_reminder: document.getElementById("notif-lesson").classList.contains("on"),
      payment_due: document.getElementById("notif-payment").classList.contains("on"),
      reschedule: document.getElementById("notif-reschedule").classList.contains("on"),
    };
    const ok = await saveProfileRow({});
    if (!ok) { showToast("Не удалось сохранить"); return; }
    showToast("Настройки сохранены");
    closeModal();
  };

  /* ---------------------------------------------------------
     PUSH-УВЕДОМЛЕНИЯ НА УСТРОЙСТВО
  --------------------------------------------------------- */
  const VAPID_PUBLIC_KEY = "BGobfLG7d2oRaA44A_P02FT_mh9eR1T1EfKZJZgFFR2NWCQURHnRIRu0jANE3iCk4Nh6RAXmYdv8LHhFVoXVhN0";

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  window.enablePushNotifications = async function () {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      showToast("Этот браузер не поддерживает push-уведомления");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { showToast("Разрешение не выдано"); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      const json = sub.toJSON();
      const { error } = await sbClient.from("push_subscriptions").upsert({
        user_id: state.session.user.id, endpoint: json.endpoint,
        p256dh: json.keys.p256dh, auth: json.keys.auth,
      }, { onConflict: "endpoint" });
      if (error) { console.error(error); showToast("Не удалось сохранить подписку"); return; }
      showToast("Уведомления на устройство включены");
      closeModal();
    } catch (e) {
      console.error(e);
      showToast("Не удалось подключить уведомления");
    }
  };

  window.openPushDiagnostics = async function () {
    const checks = [];

    const swSupported = "serviceWorker" in navigator;
    const pushSupported = "PushManager" in window;
    checks.push({
      label: "Push API поддерживается браузером",
      ok: swSupported && pushSupported,
      hint: !swSupported ? "Браузер не поддерживает Service Worker" : !pushSupported ? "Браузер не поддерживает Push API (в iOS работает только в режиме PWA, добавленном на экран «Домой», начиная с iOS 16.4)" : "",
    });

    let reg = null;
    try { reg = await navigator.serviceWorker.getRegistration(); } catch (e) { /* noop */ }
    checks.push({
      label: "Service Worker зарегистрирован и активен",
      ok: !!(reg && reg.active),
      hint: !reg ? "Service Worker не зарегистрирован — переоткройте сайт" : !reg.active ? "Зарегистрирован, но ещё не активировался" : "",
    });

    const permission = (typeof Notification !== "undefined") ? Notification.permission : "unsupported";
    checks.push({
      label: "Разрешение на уведомления выдано",
      ok: permission === "granted",
      hint: permission === "denied" ? "Заблокировано — включите вручную в настройках браузера/сайта" : permission === "default" ? "Ещё не запрашивалось — нажмите «Включить уведомления»" : "",
    });

    let clientSub = null;
    if (reg) { try { clientSub = await reg.pushManager.getSubscription(); } catch (e) { /* noop */ } }
    checks.push({
      label: "Подписка создана в браузере",
      ok: !!clientSub,
      hint: !clientSub ? "Нажмите «Включить уведомления на устройство»" : "",
    });

    let savedInDb = false;
    if (clientSub && state.session) {
      const { data } = await sbClient.from("push_subscriptions").select("id").eq("endpoint", clientSub.toJSON().endpoint).maybeSingle();
      savedInDb = !!data;
    }
    checks.push({
      label: "Подписка сохранена в базе",
      ok: savedInDb,
      hint: !savedInDb && clientSub ? "Подписка есть в браузере, но не записана в базу — попробуйте включить уведомления ещё раз" : "",
    });

    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    checks.push({
      label: "Открыто как установленное приложение (не вкладка браузера)",
      ok: isStandalone,
      hint: !isStandalone ? "На iPhone push работает ТОЛЬКО если сайт добавлен на экран «Домой» и открыт оттуда, а не из Safari" : "",
    });

    openModal(`
      <div class="modal-header"><h2>Диагностика уведомлений</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      ${checks.map((c) => `
        <div class="row" style="border:none;padding:8px 0;align-items:flex-start">
          <div class="row-main">
            <div class="row-title" style="font-size:14px">${c.ok ? "🟢" : "🔴"} ${escapeHTML(c.label)}</div>
            ${!c.ok && c.hint ? `<div class="row-sub" style="color:var(--danger)">${escapeHTML(c.hint)}</div>` : ""}
          </div>
        </div>`).join("")}
      <div class="small muted" style="margin-top:10px">На iPhone финальную доставку push можно проверить только на реальном устройстве — эмулятор и этот чек-лист не заменяют настоящую проверку.</div>
    `);
  };

  /* ---------------------------------------------------------
     «МОЙ РЕПЕТИТОР» (для родителя и ученика)
  --------------------------------------------------------- */
  async function fetchMyTutorInfo() {
    const tutorRes = await sbClient.from("tutors").select("user_id, description, subjects").limit(1);
    const t = (tutorRes.data || [])[0];
    if (!t) { state.myTutor = null; return; }
    const profRes = await sbClient.from("user_profiles").select("full_name, last_name, avatar_url").eq("user_id", t.user_id).maybeSingle();
    const name = [profRes.data?.full_name, profRes.data?.last_name].filter(Boolean).join(" ") || "Репетитор";
    state.myTutor = {
      name, avatarUrl: profRes.data?.avatar_url || "",
      description: t.description || "", subjects: t.subjects || [],
    };
  }

  window.openMyTutorModal = async function () {
    if (!state.myTutor) await fetchMyTutorInfo();
    const t = state.myTutor;
    if (!t) { showToast("Информация о репетиторе пока недоступна"); return; }
    openModal(`
      <div class="modal-header"><h2>Мой репетитор</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div style="display:flex;flex-direction:column;align-items:center;margin-bottom:16px">
        <div class="profile-avatar-lg" style="${t.avatarUrl ? `background-image:url('${t.avatarUrl}');background-size:cover;background-position:center;` : ""}">${t.avatarUrl ? "" : escapeHTML((t.name[0] || "?").toUpperCase())}</div>
        <div style="font-weight:700;font-size:18px;margin-top:10px">${escapeHTML(t.name)}</div>
        ${t.subjects.length ? `<div class="small muted" style="margin-top:2px">${t.subjects.map(escapeHTML).join(" · ")}</div>` : ""}
      </div>
      ${t.description ? `<div class="small" style="line-height:1.5">${escapeHTML(t.description)}</div>` : `<div class="small muted">Репетитор ещё не заполнил информацию о себе</div>`}
    `);
  };

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

    const activeStudents = state.students.filter((s) => s.status === "active").length;
    const monthRange = periodRange("month");
    const monthBalance = incomeLessonsInRange(monthRange).reduce((s, l) => s + (l.price || 0), 0)
      - expensesInRange(monthRange).reduce((s, e) => s + (e.amount || 0), 0);
    const monthStats = statsForPeriod("month");

    const nextBlock = next ? `
      <div class="next-lesson">
        <div class="time">${next.time}</div>
        <div style="flex:1">
          <div class="who">${escapeHTML(getStudent(next.studentId)?.name || "Ученик")}</div>
          <div class="sub">${next.date === todayISO() ? "сегодня" : humanDate(next.date)} · ближайшее занятие</div>
        </div>
      </div>` : "";

    return `
      ${state.pendingRequests.length > 0 ? `
        <button class="quick-btn" style="margin-bottom:10px;border-color:var(--warning);background:var(--warning-soft)" onclick="openRequestsModal()">
          <span class="ico">📨</span>Запросы, требующие подтверждения — ${state.pendingRequests.length}
        </button>` : ""}

      <div class="hero">
        <div class="hero-label">Доход за сегодня</div>
        <div class="hero-amount">${money(income)}</div>
        <div class="hero-stats">
          <div class="hero-stat"><div class="n">${cnt}</div><div class="l">занятий сегодня</div></div>
          <div class="hero-stat"><div class="n">${unpaid}</div><div class="l">не оплачено всего</div></div>
        </div>
        ${nextBlock}
      </div>

      <button class="quick-btn primary" style="margin-bottom:14px" onclick="openConductLesson()"><span class="ico">➕</span> Провести занятие</button>

      <div class="card">
        <div class="card-title">Занятия сегодня</div>
        ${todays.length === 0 ? `<div class="empty"><div class="ico">📭</div><div class="t">Сегодня занятий нет</div><div class="s">Добавьте занятие в расписании</div></div>` :
        todays.map((l) => lessonRowHTML(l)).join("")}
      </div>

      <div class="section-grid section-gap">
        <button class="section-card row-tap" onclick="goTo('schedule')">
          <span class="ico">📅</span>
          <div class="t">Расписание</div>
          <div class="v">${cnt} сегодня</div>
        </button>
        <button class="section-card row-tap" onclick="goTo('students')">
          <span class="ico">👨‍🎓</span>
          <div class="t">Ученики</div>
          <div class="v">${activeStudents} активных</div>
        </button>
        <button class="section-card row-tap" onclick="goTo('finances')">
          <span class="ico">💰</span>
          <div class="t">Финансы</div>
          <div class="v">${money(monthBalance)}</div>
        </button>
        <button class="section-card row-tap" onclick="goTo('stats')">
          <span class="ico">📊</span>
          <div class="t">Статистика</div>
          <div class="v">${monthStats.lessonsCount} занятий/мес</div>
        </button>
      </div>
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
  const HOUR_PX = 52;

  function hoursLabelColumnHTML() {
    return `<div class="week-hours-col">
      ${Array.from({ length: 24 }, (_, h) => `<div class="day-hour-row"><span class="day-hour-label">${pad(h)}:00</span></div>`).join("")}
    </div>`;
  }

  // opts: { lessons, freeSlots, readOnly, onLessonClick }
  // Тутор (по умолчанию): создание по тапу, удаление окна по тапу, открывает редактирование.
  // Только чтение (родитель/ученик): без создания/удаления, свой обработчик клика по занятию.
  function dayColumnHoursHTML(dateISO, opts) {
    opts = opts || {};
    const readOnly = !!opts.readOnly;
    const lessonsList = (opts.lessons || state.lessons).filter((l) => l.date === dateISO);
    const freeSlotsList = opts.freeSlots || state.freeSlots;
    const onLessonClick = opts.onLessonClick || "openEditLesson";
    const weekday = (dateFromISO(dateISO).getDay() + 6) % 7;
    const slots = freeSlotsList.filter((s) => s.weekday === weekday);

    const freeBlocks = slots.map((s) => {
      const [sh, sm] = s.start_time.slice(0, 5).split(":").map(Number);
      const [eh, em] = s.end_time.slice(0, 5).split(":").map(Number);
      const top = ((sh * 60 + sm) / 60) * HOUR_PX;
      const height = Math.max(18, (((eh * 60 + em) - (sh * 60 + sm)) / 60) * HOUR_PX);
      const clickAttr = readOnly ? "" : `onclick="event.stopPropagation(); confirmDeleteFreeSlot('${s.id}')"`;
      return `<div class="day-freeslot-block" style="top:${top}px;height:${height}px" ${clickAttr} title="Свободное окно${readOnly ? "" : " — нажмите, чтобы удалить"}"></div>`;
    }).join("");

    const lessonBlocks = lessonsList.map((l) => {
      const [h, m] = l.time.split(":").map(Number);
      const top = ((h * 60 + m) / 60) * HOUR_PX;
      const height = Math.max(20, ((l.duration || 60) / 60) * HOUR_PX - 2);
      const cls = l.status === "done" ? "status-done" : l.status === "cancelled" ? "status-cancelled" : l.status === "moved" ? "status-moved" : "";
      const label = readOnly ? STATUS_LABEL[l.status] : (getStudent(l.studentId)?.name || "Ученик");
      return `<div class="day-lesson-block ${cls}" style="top:${top}px;height:${height}px" onclick="event.stopPropagation(); ${onLessonClick}('${l.id}')">
        <div class="t">${l.time}</div><div class="w">${escapeHTML(label)}</div>
      </div>`;
    }).join("");

    const nowLine = isToday(dateISO) ? (() => {
      const now = new Date();
      const top = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX;
      return `<div class="day-now-line" style="top:${top}px"></div>`;
    })() : "";

    const hourRows = Array.from({ length: 24 }, () => `<div class="day-hour-row"></div>`).join("");
    const clickHandler = readOnly ? "" : `onclick="handleDayGridClick(event,'${dateISO}')"`;

    return `<div class="day-hours-area" style="height:${24 * HOUR_PX}px" ${clickHandler}>
      ${hourRows}${freeBlocks}${lessonBlocks}${nowLine}
    </div>`;
  }

  // Готовый блок «неделя почасово», переиспользуемый и в расписании
  // репетитора, и в календарях родителя/ученика (там — только чтение).
  function weekHourGridHTML(days, opts) {
    opts = opts || {};
    const wide = days.length === 1;
    return `
      <div class="week-grid-wrap">
        <div class="week-grid-scroll">
          ${hoursLabelColumnHTML()}
          ${days.map((d) => `
            <div class="week-day-col" ${wide ? 'style="width:100%"' : ""}>
              ${wide ? "" : `<div class="week-day-col-header ${isToday(d) ? "today" : ""}">${weekdayShort(d)} ${dateFromISO(d).getDate()}</div>`}
              ${dayColumnHoursHTML(d, opts)}
            </div>
          `).join("")}
        </div>
      </div>`;
  }

  // Календарь только для чтения — для кабинетов родителя и ученика.
  // Своя (отдельная от расписания репетитора) навигация по неделям.
  function renderReadOnlyWeek(lessons, freeSlots, onLessonClick) {
    if (!state.schedule.roWeekStart) state.schedule.roWeekStart = startOfWeekISO(todayISO());
    const ws = state.schedule.roWeekStart;
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const nav = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <button class="back" onclick="roWeekShift(-1)">‹</button>
        <div class="small muted" style="font-weight:600">${humanDate(ws)} – ${humanDate(addDays(ws, 6))}</div>
        <button class="back" onclick="roWeekShift(1)">›</button>
      </div>`;
    return nav + weekHourGridHTML(days, { lessons, freeSlots, readOnly: true, onLessonClick: onLessonClick || "openParentLessonDetail" });
  }
  window.roWeekShift = function (dir) {
    if (!state.schedule.roWeekStart) state.schedule.roWeekStart = startOfWeekISO(todayISO());
    state.schedule.roWeekStart = addDays(state.schedule.roWeekStart, dir * 7);
    render();
  };

  window.handleDayGridClick = function (evt, dateISO) {
    const rect = evt.currentTarget.getBoundingClientRect();
    const y = evt.clientY - rect.top;
    let totalMinutes = Math.round((y / HOUR_PX) * 60 / 15) * 15;
    totalMinutes = Math.max(0, Math.min(23 * 60 + 45, totalMinutes));
    const time = `${pad(Math.floor(totalMinutes / 60))}:${pad(totalMinutes % 60)}`;
    openQuickCreateSheet(dateISO, time);
  };

  window.confirmDeleteFreeSlot = async function (id) {
    if (!confirm("Удалить это свободное окно?")) return;
    const ok = await dbDeleteFreeSlot(id);
    if (!ok) return;
    state.freeSlots = state.freeSlots.filter((s) => s.id !== id);
    showToast("Окно удалено");
    render();
  };

  window.openQuickCreateSheet = function (dateISO, time) {
    openModal(`
      <div class="modal-header"><h2>${humanDate(dateISO)}, ${time}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <button class="btn btn-primary" style="width:100%;margin-bottom:8px" onclick="openQuickLessonForm('${dateISO}','${time}')">➕ Создать занятие</button>
      <button class="btn btn-secondary" style="width:100%" onclick="quickCreateFreeSlot('${dateISO}','${time}')">🟢 Отметить как свободное окно</button>
    `);
  };

  window.openQuickLessonForm = function (dateISO, time) {
    if (!state.students.length) { showToast("Сначала добавьте ученика"); return; }
    const studentOptions = state.students.filter((s) => s.status === "active").map((s) => `<option value="${s.id}">${escapeHTML(s.name)}</option>`).join("");
    openModal(`
      <div class="modal-header"><h2>Новое занятие</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="small muted" style="margin-bottom:10px">${humanDate(dateISO)}, начало ${time}</div>
      <div class="field"><label>Ученик</label><select id="q-student">${studentOptions}</select></div>
      <div class="field"><label>Продолжительность</label>
        <div class="chip-row" id="q-duration-chips">
          ${[30, 45, 60, 90, 120].map((m) => `<button type="button" class="chip ${m === 60 ? "active" : ""}" data-min="${m}" onclick="pickDurationChip(this,'q-duration-chips','q-duration')">${m} мин</button>`).join("")}
        </div>
        <input type="number" id="q-duration" value="60" min="10" step="5" style="margin-top:8px" />
      </div>
      <button class="btn btn-primary" style="width:100%" onclick="quickCreateLesson('${dateISO}','${time}')">Создать</button>
    `);
  };

  window.quickCreateLesson = async function (dateISO, time) {
    const studentId = document.getElementById("q-student").value;
    const duration = Number(document.getElementById("q-duration").value) || 60;
    const student = getStudent(studentId);
    if (!student) { showToast("Выберите ученика"); return; }
    const conflict = findLessonConflict(dateISO, time, duration, null);
    if (conflict) {
      const cst = getStudent(conflict.studentId);
      if (!confirm(`Пересекается с занятием ${conflict.time} (${cst?.name || "ученик"}). Создать всё равно?`)) return;
    }
    await withGuard("quickCreateLesson", async () => {
      const created = await dbInsertLesson({
        studentId, date: dateISO, time, duration, price: student.price,
        status: "planned", paid: false, hwDone: false, homework: "", comment: "",
      });
      if (!created) return;
      state.lessons.push(created);
      closeModal();
      showToast("Занятие создано");
      render();
    });
  };

  window.quickCreateFreeSlot = async function (dateISO, time) {
    const weekday = (dateFromISO(dateISO).getDay() + 6) % 7;
    const [h, m] = time.split(":").map(Number);
    const endH = Math.min(h + 2, 23);
    const endTime = `${pad(endH)}:${pad(m)}`;
    const created = await dbInsertFreeSlot(weekday, time, endTime);
    if (!created) return;
    state.freeSlots.push(created);
    state.freeSlots.sort((a, b) => a.weekday - b.weekday);
    closeModal();
    showToast(`Окно добавлено на ${WEEKDAY_FULL[weekday].toLowerCase()}`);
    render();
  };

  function renderSchedule() {
    ensureScheduleInit();
    const ws = state.schedule.weekStart;
    const sel = state.schedule.selectedDate;
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const mode = state.schedule.mode;

    const modeToggle = `
      <div class="segmented" style="margin-bottom:14px">
        <button class="${mode === "day" ? "active" : ""}" onclick="scheduleSetMode('day')">День</button>
        <button class="${mode === "week" ? "active" : ""}" onclick="scheduleSetMode('week')">Неделя</button>
        <button class="${mode === "month" ? "active" : ""}" onclick="scheduleSetMode('month')">Месяц</button>
      </div>`;

    if (mode === "month") {
      const ms = state.schedule.monthStart;
      const dates = monthGridDates(ms);
      const curMonth = dateFromISO(ms).getMonth();
      const monthLabel = `${MONTHS_NOM[curMonth]} ${dateFromISO(ms).getFullYear()}`;
      const monthNav = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <button class="back" onclick="scheduleShiftMonth(-1)">‹</button>
          <div class="small muted" style="font-weight:600">${monthLabel}</div>
          <button class="back" onclick="scheduleShiftMonth(1)">›</button>
        </div>`;
      const grid = `
        <div class="month-grid-labels">${WEEKDAY_SHORT.map((w) => `<div>${w}</div>`).join("")}</div>
        <div class="month-grid">
          ${dates.map((d) => {
            const inMonth = dateFromISO(d).getMonth() === curMonth;
            const count = lessonsOnDate(d).length;
            return `<button class="month-cell ${inMonth ? "" : "outside"} ${isToday(d) ? "today" : ""} ${d === sel ? "selected" : ""}" onclick="scheduleSelectDay('${d}')">
              <div class="n">${dateFromISO(d).getDate()}</div>
              ${count ? `<div class="dot"></div>` : ""}
            </button>`;
          }).join("")}
        </div>`;
      return `${modeToggle}${monthNav}${grid}`;
    }

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

    let body = "";
    if (mode === "day") {
      body = `
        <div class="day-group-title">${weekdayFull(sel)}, ${humanDate(sel)}</div>
        ${weekHourGridHTML([sel])}
      `;
    } else {
      body = weekHourGridHTML(days);
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
  window.scheduleShiftMonth = function (dir) {
    state.schedule.monthStart = addMonths(state.schedule.monthStart, dir);
    render();
  };
  window.scheduleSelectDay = function (d) {
    state.schedule.selectedDate = d;
    state.schedule.mode = "day";
    render();
  };
  window.scheduleSetMode = function (m) {
    state.schedule.mode = m;
    if (m === "month") state.schedule.monthStart = startOfMonthISO(state.schedule.selectedDate);
    if (m === "week") state.schedule.weekStart = startOfWeekISO(state.schedule.selectedDate);
    render();
  };

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
        ${st.parentCode ? `<div class="section-gap" style="background:var(--accent-soft);border-radius:var(--radius-md);padding:10px 12px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div class="small" style="font-weight:600;color:var(--accent-ink)">Код: ${escapeHTML(st.parentCode)}</div>
            <button class="btn-ghost" style="padding:4px 10px;background:rgba(255,255,255,0.6);border-radius:999px;font-size:12px" onclick="copyInviteCode('${escapeHTML(st.parentCode)}')">Скопировать</button>
          </div>
          <div class="small muted" style="margin-top:2px">Передайте его родителю или ученику — они смогут зарегистрироваться и получить доступ к этому ученику</div>
        </div>` : ""}
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
  window.openEditLesson = async function (id) {
    await renderLessonForm(state.lessons.find((l) => l.id === id));
  };

  async function renderLessonForm(lesson, defaultDate) {
    const isEdit = !!lesson;
    let reportText = "";
    if (isEdit && lesson.status === "done") {
      const { data } = await sbClient.from("lesson_reports").select("what_covered").eq("lesson_id", lesson.id).maybeSingle();
      reportText = data?.what_covered || "";
    }
    const studentOptions = state.students.map((s) => `<option value="${s.id}" ${lesson?.studentId === s.id ? "selected" : ""}>${escapeHTML(s.name)}</option>`).join("");
    openModal(`
      <div class="modal-header"><h2>${isEdit ? "Занятие" : "Новое занятие"}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="field"><label>Ученик</label><select id="l-student">${studentOptions}</select></div>
      <div class="field-row">
        <div class="field"><label>Дата</label><input type="date" id="l-date" value="${lesson?.date || defaultDate || todayISO()}" /></div>
        <div class="field"><label>Время</label><input type="time" id="l-time" value="${lesson?.time || "16:00"}" /></div>
      </div>
      <div class="field"><label>Продолжительность</label>
        <div class="chip-row" id="l-duration-chips">
          ${[30, 45, 60, 90, 120].map((m) => `<button type="button" class="chip ${((lesson?.duration || 60) === m) ? "active" : ""}" data-min="${m}" onclick="pickDurationChip(this)">${m} мин</button>`).join("")}
        </div>
        <input type="number" id="l-duration" value="${lesson?.duration || 60}" min="10" step="5" style="margin-top:8px" placeholder="Своя продолжительность, мин" />
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
      <div class="field"><label>Ссылка на доску</label><input type="text" id="l-board-link" value="${escapeHTML(lesson?.boardLink || "")}" placeholder="https://..." /></div>
      <div class="field"><label>Ссылка на созвон</label><input type="text" id="l-meeting-link" value="${escapeHTML(lesson?.meetingLink || "")}" placeholder="https://..." /></div>
      <div class="field"><label>Домашнее задание</label><textarea id="l-homework" placeholder="Необязательно">${escapeHTML(lesson?.homework || "")}</textarea></div>
      <div class="field">
        <label>Файл к домашнему заданию</label>
        <input type="file" id="l-hw-file" accept="image/*,.pdf,.doc,.docx" />
        ${lesson?.homeworkFileUrl ? `<div class="small" style="margin-top:6px"><a href="${lesson.homeworkFileUrl}" target="_blank" style="color:var(--accent-ink);font-weight:600">📎 Уже загружен файл</a></div>` : ""}
      </div>
      ${isEdit && lesson.status === "done" ? `
        <div class="field"><label>Отчёт по занятию (видит только родитель)</label><textarea id="l-report" placeholder="Что изучали, успехи, ошибки, рекомендации">${escapeHTML(reportText)}</textarea></div>
      ` : ""}
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
    const duration = Number(document.getElementById("l-duration").value) || 60;
    const boardLink = document.getElementById("l-board-link").value.trim();
    const meetingLink = document.getElementById("l-meeting-link").value.trim();
    const homework = document.getElementById("l-homework").value.trim();
    const comment = document.getElementById("l-comment").value.trim();
    const student = getStudent(studentId);
    if (!student) { showToast("Выберите ученика"); return; }
    const reportEl = document.getElementById("l-report");
    const hwFile = document.getElementById("l-hw-file")?.files?.[0];

    const conflict = findLessonConflict(date, time, duration, id);
    if (conflict) {
      const cst = getStudent(conflict.studentId);
      const proceed = confirm(`Пересекается с занятием ${conflict.time} (${cst?.name || "ученик"}). Сохранить всё равно?`);
      if (!proceed) return;
    }

    await withGuard("saveLesson", async () => {
    let homeworkFileUrl;
    if (hwFile) homeworkFileUrl = await uploadLessonFile(id || "new-" + Date.now(), "homework", hwFile);
    if (id) {
      const l = state.lessons.find((x) => x.id === id);
      const statusEl = document.getElementById("l-status");
      const paidEl = document.getElementById("l-paid-switch");
      const merged = {
        ...l, studentId, date, time, duration, homework, comment,
        boardLink, meetingLink,
        status: statusEl ? statusEl.value : l.status,
        paid: paidEl ? paidEl.classList.contains("on") : l.paid,
        homeworkFileUrl: homeworkFileUrl || l.homeworkFileUrl,
      };
      const ok = await dbUpdateLesson(id, merged);
      if (!ok) return;
      Object.assign(l, merged);
      if (reportEl) await saveLessonReport(id, reportEl.value.trim());
      showToast("Занятие обновлено");
    } else {
      const created = await dbInsertLesson({
        studentId, date, time, duration, homework, comment, boardLink, meetingLink,
        status: "planned", paid: false, hwDone: false, price: student.price,
        homeworkFileUrl,
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
     ПОВТОРЯЮЩИЕСЯ ЗАНЯТИЯ
  --------------------------------------------------------- */
  window.openAddRecurring = function () {
    if (!state.students.length) { showToast("Сначала добавьте ученика"); return; }
    const studentOptions = state.students.map((s) => `<option value="${s.id}">${escapeHTML(s.name)}</option>`).join("");
    openModal(`
      <div class="modal-header"><h2>Повторяющееся занятие</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="field"><label>Ученик</label><select id="r-student">${studentOptions}</select></div>
      <div class="field-row">
        <div class="field"><label>День недели</label>
          <select id="r-weekday">
            ${WEEKDAY_FULL.map((w, i) => `<option value="${i}">${w}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Время</label><input type="time" id="r-time" value="16:00" /></div>
      </div>
      <div class="field"><label>Периодичность</label>
        <select id="r-repeat">
          <option value="weekly">Каждую неделю</option>
          <option value="biweekly">Раз в две недели</option>
        </select>
      </div>
      <div class="field-row">
        <div class="field"><label>Дата начала</label><input type="date" id="r-start" value="${todayISO()}" /></div>
        <div class="field"><label>Дата окончания</label><input type="date" id="r-end" value="${addDays(todayISO(), 84)}" /></div>
      </div>
      <div class="small muted" style="margin-bottom:10px">Занятия будут автоматически созданы в расписании на весь указанный период.</div>
      <button class="btn btn-primary" onclick="saveRecurring()">Создать занятия</button>
    `);
  };

  window.saveRecurring = async function () {
    const studentId = document.getElementById("r-student").value;
    const weekday = Number(document.getElementById("r-weekday").value);
    const time = document.getElementById("r-time").value;
    const repeat = document.getElementById("r-repeat").value;
    const startDate = document.getElementById("r-start").value;
    const endDate = document.getElementById("r-end").value;
    const student = getStudent(studentId);
    if (!student) { showToast("Выберите ученика"); return; }
    if (!startDate || !endDate || endDate < startDate) { showToast("Проверьте даты начала и окончания"); return; }

    await withGuard("saveRecurring", async () => {
      let cur = startDate;
      while ((dateFromISO(cur).getDay() + 6) % 7 !== weekday) cur = addDays(cur, 1);
      const step = repeat === "biweekly" ? 14 : 7;
      const dates = [];
      while (cur <= endDate) { dates.push(cur); cur = addDays(cur, step); }
      if (!dates.length) { showToast("В выбранном периоде нет подходящих дат"); return; }

      const { data: ruleRow, error: ruleErr } = await sbClient.from("recurring_schedules").insert({
        student_id: studentId, weekday, start_time: time, duration: student.duration,
        repeat_type: repeat, start_date: startDate, end_date: endDate, price: student.price,
      }).select().single();
      if (ruleErr) { console.error(ruleErr); showToast("Не удалось создать повторение"); return; }

      const rows = dates.map((d) => ({
        student_id: studentId, date: d, time, status: "planned",
        price: student.price, paid: false, homework: "", comment: "",
        recurring_schedule_id: ruleRow.id,
      }));
      const { data: created, error: insErr } = await sbClient.from("lessons").insert(rows).select();
      if (insErr) { console.error(insErr); showToast("Занятия не удалось создать"); return; }
      state.lessons.push(...(created || []).map(lessonFromRow));
      closeModal();
      showToast(`Создано занятий: ${(created || []).length}`);
      render();
    });
  };

  /* ---------------------------------------------------------
     CONDUCT LESSON FLOW (main scenario)
     Работает ТОЛЬКО с уже существующими запланированными занятиями —
     сначала занятие создаётся в расписании, а «Провести занятие»
     лишь отмечает его результат. Ничего нового здесь не создаётся.
  --------------------------------------------------------- */
  window.openConductLesson = function (presetStudentId) {
    state.conduct = { step: 1, filterStudentId: presetStudentId || null, lessonId: null, studentId: null, status: null };
    renderConductModal();
  };

  function plannedLessonsFor(studentId) {
    return state.lessons
      .filter((l) => l.status === "planned" && (!studentId || l.studentId === studentId))
      .sort((a, b) => combineTS(a.date, a.time) - combineTS(b.date, b.time));
  }

  function renderConductModal() {
    const c = state.conduct;
    if (c.step === 1) {
      const list = plannedLessonsFor(c.filterStudentId);
      const scopedStudent = c.filterStudentId ? getStudent(c.filterStudentId) : null;
      if (!list.length) {
        openModal(`
          <div class="modal-header"><h2>Провести занятие</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
          ${emptyBlock("🗓️", "Нет запланированных занятий", scopedStudent ? "У этого ученика нет занятий в расписании" : "Сначала добавьте занятие в разделе «Расписание»")}
          <button class="btn btn-primary" onclick="closeModal(); goTo('schedule')">Перейти в расписание</button>
        `);
        return;
      }
      openModal(`
        <div class="modal-header"><h2>${scopedStudent ? "Занятия " + escapeHTML(scopedStudent.name) : "Выберите занятие"}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="small muted" style="margin-bottom:10px">Выберите запланированное занятие, чтобы отметить его результат</div>
        ${list.map((l) => {
          const st = getStudent(l.studentId);
          return `<div class="lesson-row row-tap" onclick="conductPickLesson('${l.id}')">
            <div class="lt">${l.time}</div>
            <div class="lm">
              <div class="lname">${escapeHTML(st ? st.name : "Ученик удалён")}</div>
              <div class="lsub">${humanDate(l.date)} · ${money(l.price)}</div>
            </div>
            <span class="chev">›</span>
          </div>`;
        }).join("")}
      `);
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
        <button class="btn btn-ghost" style="width:100%;margin-top:8px" onclick="state.conduct.step=1; renderConductModal()">← К списку занятий</button>
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
          <div class="field">
            <label>Файл к домашнему заданию</label>
            <input type="file" id="c-hw-file" accept="image/*,.pdf,.doc,.docx" />
          </div>
          <div class="field"><label>Отчёт по занятию (видит только родитель)</label><textarea id="c-report" placeholder="Что изучали, успехи, ошибки, рекомендации"></textarea></div>`;
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

  window.conductPickLesson = function (lessonId) {
    const l = state.lessons.find((x) => x.id === lessonId);
    if (!l) return;
    state.conduct.lessonId = l.id;
    state.conduct.studentId = l.studentId;
    state.conduct.date = l.date;
    state.conduct.time = l.time;
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
    const reportText = document.getElementById("c-report")?.value.trim() || "";

    let payload = { status: c.status, comment };
    if (c.status === "done") {
      payload.paid = document.getElementById("c-paid-switch")?.classList.contains("on") || false;
      payload.homework = document.getElementById("c-homework")?.value.trim() || "";
      payload.date = document.getElementById("c-done-date").value;
      payload.time = document.getElementById("c-done-time").value;
      const hwFile = document.getElementById("c-hw-file")?.files?.[0];
      if (hwFile) {
        const url = await uploadLessonFile(c.lessonId, "homework", hwFile);
        if (url) payload.homeworkFileUrl = url;
      }
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
      if (c.status === "done") await saveLessonReport(c.lessonId, reportText);
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
      if (c.status === "done") await saveLessonReport(created.id, reportText);
    }
    closeModal();
    state.conduct = null;
    showToast("Занятие сохранено");
    render();
    });
  };

  /* ---------------------------------------------------------
     PARENT APP (роль «родитель») — только чтение
  --------------------------------------------------------- */
  function renderParentApp() {
    const kids = state.parentChildren;
    return `
      <div class="topbar">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <h1 style="margin:0">Кабинет родителя</h1>
          ${profileButtonHTML()}
        </div>
      </div>
      <div class="view">
        ${kids.length > 0 ? `<button class="pill-tab" style="margin-bottom:14px" onclick="openMyTutorModal()">👤 Мой репетитор</button>` : ""}
        ${kids.length === 0 ? `
          <div class="card">
            <div class="card-title">Добавить ребёнка</div>
            <div class="small muted" style="margin-bottom:10px">Введите код, который дал репетитор</div>
            <div class="field"><input type="text" id="p-code" placeholder="Например, a1b2c3" /></div>
            <button class="btn btn-primary" onclick="parentLinkChild()">Добавить</button>
          </div>
        ` : kids.map((st) => renderParentChildCard(st)).join("")}
        ${kids.length > 0 ? `
          <div class="card">
            <div class="card-title">Добавить ещё одного ребёнка</div>
            <div class="field"><input type="text" id="p-code" placeholder="Код от репетитора" /></div>
            <button class="btn btn-secondary" onclick="parentLinkChild()">Добавить</button>
          </div>` : ""}
      </div>`;
  }

  function renderParentChildCard(st) {
    const lessons = state.parentLessons
      .filter((l) => l.studentId === st.id)
      .sort((a, b) => combineTS(b.date, b.time) - combineTS(a.date, a.time));
    const debt = lessons.filter((l) => l.status === "done" && !l.paid).reduce((s, l) => s + (l.price || 0), 0);
    const upcoming = lessons
      .filter((l) => l.status === "planned" && combineTS(l.date, l.time) >= Date.now())
      .sort((a, b) => combineTS(a.date, a.time) - combineTS(b.date, b.time))[0];
    return `
      <div class="card">
        <div style="font-weight:700;font-size:18px">${escapeHTML(st.name)}</div>
        <div class="muted small">${escapeHTML(st.grade || "—")}</div>
        <div class="section-gap">${debt > 0
          ? `<span class="badge danger">Задолженность: ${money(debt)}</span>`
          : `<span class="badge success">Задолженностей нет</span>`}</div>
        ${upcoming ? `
          <div class="next-lesson" style="background:var(--accent-soft);color:var(--ink);margin-top:10px">
            <div class="time" style="background:rgba(0,0,0,0.06)">${upcoming.time}</div>
            <div><div class="who">Ближайшее занятие</div><div class="sub">${humanDate(upcoming.date)}</div></div>
          </div>` : ""}

        <div class="card-title section-gap">Расписание</div>
        ${renderReadOnlyWeek(lessons, state.freeSlots)}

        <div class="card-title section-gap">История занятий</div>
        ${lessons.length === 0 ? `<div class="small muted">Занятий пока нет</div>` : lessons.slice(0, 15).map((l) => `
          <div class="row row-tap" onclick="openParentLessonDetail('${l.id}')">
            <div class="row-main">
              <div class="row-title">${humanDate(l.date)} · ${l.time}</div>
              <div class="row-sub">${l.homework ? "ДЗ: " + escapeHTML(l.homework) : "&nbsp;"}</div>
            </div>
            <div class="row-trail">
              <span class="badge ${STATUS_BADGE_CLASS[l.status]}">${STATUS_LABEL[l.status]}</span>
              ${l.status === "done" ? `<div style="margin-top:4px"><span class="badge ${l.paid ? "success" : "danger"}">${l.paid ? "оплачено" : "не оплачено"}</span></div>` : ""}
            </div>
          </div>`).join("")}
      </div>`;
  }

  window.openParentLessonDetail = async function (lessonId) {
    const l = state.parentLessons.find((x) => x.id === lessonId);
    if (!l) return;
    const st = state.parentChildren.find((s) => s.id === l.studentId);
    let reportText = "";
    if (l.status === "done") {
      const { data } = await sbClient.from("lesson_reports").select("what_covered").eq("lesson_id", lessonId).maybeSingle();
      reportText = data?.what_covered || "";
    }
    let paymentRow = null;
    if (l.status === "done" && !l.paid) {
      const { data } = await sbClient.from("payments").select("*").eq("lesson_id", lessonId).maybeSingle();
      paymentRow = data || null;
    }
    openModal(`
      <div class="modal-header"><h2>${humanDate(l.date)} · ${l.time}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="small muted" style="margin-bottom:10px">${escapeHTML(st?.name || "")} · ${money(l.price)}</div>
      <span class="badge ${STATUS_BADGE_CLASS[l.status]}">${STATUS_LABEL[l.status]}</span>
      ${l.status === "done" ? `<span class="badge ${l.paid ? "success" : "danger"}" style="margin-left:6px">${l.paid ? "оплачено" : "не оплачено"}</span>` : ""}

      ${(l.boardLink || l.meetingLink) ? `<div class="btn-row section-gap">
        ${l.boardLink ? `<a class="btn btn-secondary" href="${l.boardLink}" target="_blank">🖊️ Доска</a>` : ""}
        ${l.meetingLink ? `<a class="btn btn-secondary" href="${l.meetingLink}" target="_blank">🎥 Созвон</a>` : ""}
      </div>` : ""}

      ${l.homework ? `<div class="card-title section-gap">Домашнее задание</div><div class="small">${escapeHTML(l.homework)}</div>` : ""}
      ${l.homeworkFileUrl ? `<div class="small" style="margin-top:6px"><a href="${l.homeworkFileUrl}" target="_blank" style="color:var(--accent-ink);font-weight:600">📎 Открыть файл от репетитора</a></div>` : ""}

      ${l.status === "done" ? `<div class="card-title section-gap">Отчёт по занятию</div><div class="small">${reportText ? escapeHTML(reportText) : `<span class="muted">Репетитор ещё не заполнил отчёт</span>`}</div>` : ""}

      ${l.status === "done" && !l.paid ? `
        <div class="card-title section-gap">Подтверждение оплаты</div>
        ${paymentRow?.proof_url ? `<div class="small" style="margin-bottom:4px"><a href="${paymentRow.proof_url}" target="_blank" style="color:var(--accent-ink);font-weight:600">📎 Уже загруженный скриншот</a></div>` : ""}
        <div class="field"><label>Скриншот оплаты</label><input type="file" id="pf-file" accept="image/*" /></div>
        <div class="field"><label>или ссылка на чек</label><input type="text" id="pf-link" placeholder="https://..." value="${escapeHTML(paymentRow?.proof_link || "")}" /></div>
        <button class="btn btn-secondary" style="width:100%" onclick="submitPaymentProof('${l.id}', '${st.id}')">Отправить подтверждение</button>
      ` : ""}

      ${l.status === "planned" ? `
        <div class="btn-row section-gap">
          <button class="btn btn-secondary" onclick="requestCancel('${l.id}')">Отменить</button>
          <button class="btn btn-secondary" onclick="openRescheduleOptions('${l.id}')">Перенести</button>
        </div>
      ` : ""}
    `);
  };

  window.submitPaymentProof = async function (lessonId, studentId) {
    const fileInput = document.getElementById("pf-file");
    const link = document.getElementById("pf-link").value.trim();
    const file = fileInput?.files?.[0];
    let proofUrl = null;
    if (file) proofUrl = await uploadLessonFile(lessonId, "payment", file);
    const l = state.parentLessons.find((x) => x.id === lessonId);
    const { data: existing } = await sbClient.from("payments").select("id").eq("lesson_id", lessonId).maybeSingle();
    const patch = { lesson_id: lessonId, student_id: studentId, amount: l?.price || 0, status: "awaiting" };
    if (proofUrl) patch.proof_url = proofUrl;
    if (link) patch.proof_link = link;
    let error;
    if (existing) {
      ({ error } = await sbClient.from("payments").update(patch).eq("id", existing.id));
    } else {
      ({ error } = await sbClient.from("payments").insert(patch));
    }
    if (error) { console.error(error); showToast("Не удалось отправить"); return; }
    showToast("Отправлено репетитору");
    closeModal();
  };

  async function notifyTutorOfRequest(lessonId, type) {
    const { data: lessonRow } = await sbClient.from("lessons").select("tutor_id").eq("id", lessonId).maybeSingle();
    if (!lessonRow) return;
    const { data: tutorRow } = await sbClient.from("tutors").select("user_id").eq("id", lessonRow.tutor_id).maybeSingle();
    if (!tutorRow) return;
    const verb = type === "cancel" ? "отмену" : "перенос";
    await createNotification(tutorRow.user_id, "request", `Новый запрос на ${verb} занятия`);
  }

  window.requestCancel = async function (lessonId) {
    const reason = prompt("Причина отмены (необязательно):") || "";
    const { error } = await sbClient.from("lesson_change_requests").insert({
      lesson_id: lessonId, type: "cancel",
      requested_by: state.session.user.id, requested_by_role: state.role, reason,
    });
    if (error) { console.error(error); showToast("Не удалось отправить запрос"); return; }
    await notifyTutorOfRequest(lessonId, "cancel");
    showToast("Запрос на отмену отправлен репетитору");
    closeModal();
  };

  window.openRescheduleOptions = function (lessonId) {
    const options = upcomingFreeSlotOptions(21);
    if (!options.length) { showToast("У репетитора пока нет свободных окон для переноса"); return; }
    openModal(`
      <div class="modal-header"><h2>Выберите время</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      ${options.slice(0, 30).map((o) => `
        <div class="row row-tap" onclick="requestReschedule('${lessonId}', '${o.date}', '${o.time}')">
          <div class="row-main"><div class="row-title">${humanDate(o.date)}</div><div class="row-sub">${weekdayFull(o.date)}</div></div>
          <div class="row-amount">${o.time}</div>
        </div>`).join("")}
    `);
  };

  window.requestReschedule = async function (lessonId, newDate, newTime) {
    const { error } = await sbClient.from("lesson_change_requests").insert({
      lesson_id: lessonId, type: "reschedule",
      requested_by: state.session.user.id, requested_by_role: state.role,
      new_date: newDate, new_time: newTime,
    });
    if (error) { console.error(error); showToast("Не удалось отправить запрос"); return; }
    await notifyTutorOfRequest(lessonId, "reschedule");
    showToast("Запрос на перенос отправлен репетитору");
    closeModal();
  };

  window.parentLinkChild = async function () {
    const code = document.getElementById("p-code").value.trim();
    if (!code) { showToast("Введите код"); return; }
    const { error } = await sbClient.rpc("link_parent_to_child", { p_code: code });
    if (error) { showToast("Код не найден, проверьте у репетитора"); return; }
    await dbFetchAllParent();
    showToast("Ребёнок добавлен");
    render();
  };

  /* ---------------------------------------------------------
     STUDENT APP (роль «ученик») — только чтение
  --------------------------------------------------------- */
  function renderStudentApp() {
    const st = state.studentSelf;
    const header = `<div class="topbar">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h1 style="margin:0">${st ? "Привет, " + escapeHTML((st.name || "").split(" ")[0] || "") + "!" : "Мой кабинет"}</h1>
        ${profileButtonHTML()}
      </div>
    </div>`;

    if (!st) {
      return `${header}<div class="view">
        <div class="card">
          <div class="card-title">Привязать аккаунт</div>
          <div class="small muted" style="margin-bottom:10px">Введите код, который дал репетитор</div>
          <div class="field"><input type="text" id="s-code" placeholder="Например, a1b2c3" /></div>
          <button class="btn btn-primary" onclick="studentLinkSelf()">Привязать</button>
        </div>
      </div>`;
    }

    const lessons = state.studentLessons.slice().sort((a, b) => combineTS(b.date, b.time) - combineTS(a.date, a.time));
    const upcoming = lessons
      .filter((l) => l.status === "planned" && combineTS(l.date, l.time) >= Date.now())
      .sort((a, b) => combineTS(a.date, a.time) - combineTS(b.date, b.time))[0];
    const homeworks = lessons.filter((l) => l.homework && l.homework.trim());

    return `${header}<div class="view">
      <button class="pill-tab" style="margin-bottom:14px" onclick="openMyTutorModal()">👤 Мой репетитор</button>
      ${upcoming ? `
        <div class="hero">
          <div class="hero-label">Ближайшее занятие</div>
          <div class="hero-amount" style="font-size:26px">${humanDate(upcoming.date)}, ${upcoming.time}</div>
        </div>` : `<div class="card"><div class="small muted" style="padding:6px 0">Ближайших занятий не запланировано</div></div>`}

      <div class="card-title section-gap">Расписание</div>
      ${renderReadOnlyWeek(lessons, state.freeSlots, "openStudentHomeworkDetail")}

      <div class="card-title section-gap">Домашние задания</div>
      <div class="card" style="padding:6px 12px">
        ${homeworks.length === 0 ? `<div class="small muted" style="padding:10px 0">Заданий пока нет</div>` :
        homeworks.slice(0, 10).map((l) => `
          <div class="row row-tap" onclick="openStudentHomeworkDetail('${l.id}')">
            <div class="row-main">
              <div class="row-title">${escapeHTML(l.homework)}</div>
              <div class="row-sub">выдано ${humanDate(l.date)}${l.submissionFileUrl ? " · решение загружено" : ""}</div>
            </div>
            <span class="chev">›</span>
          </div>`).join("")}
      </div>

      <div class="card-title section-gap">История занятий</div>
      <div class="card" style="padding:6px 12px">
        ${lessons.length === 0 ? `<div class="small muted" style="padding:10px 0">Занятий пока нет</div>` :
        lessons.slice(0, 15).map((l) => `
          <div class="row row-tap" onclick="openStudentHomeworkDetail('${l.id}')">
            <div class="row-main"><div class="row-title">${humanDate(l.date)} · ${l.time}</div></div>
            <span class="badge ${STATUS_BADGE_CLASS[l.status]}">${STATUS_LABEL[l.status]}</span>
          </div>`).join("")}
      </div>
    </div>`;
  }

  window.openStudentHomeworkDetail = function (lessonId) {
    const l = state.studentLessons.find((x) => x.id === lessonId);
    if (!l) return;
    openModal(`
      <div class="modal-header"><h2>${humanDate(l.date)} · ${l.time}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <span class="badge ${STATUS_BADGE_CLASS[l.status]}">${STATUS_LABEL[l.status]}</span>

      ${(l.boardLink || l.meetingLink) ? `<div class="btn-row section-gap">
        ${l.boardLink ? `<a class="btn btn-secondary" href="${l.boardLink}" target="_blank">🖊️ Доска</a>` : ""}
        ${l.meetingLink ? `<a class="btn btn-secondary" href="${l.meetingLink}" target="_blank">🎥 Созвон</a>` : ""}
      </div>` : ""}

      ${l.homework ? `
        <div class="card-title section-gap">Домашнее задание</div>
        <div class="small">${escapeHTML(l.homework)}</div>
        ${l.homeworkFileUrl ? `<div class="small" style="margin-top:8px"><a href="${l.homeworkFileUrl}" target="_blank" style="color:var(--accent-ink);font-weight:600">📎 Материалы от репетитора</a></div>` : ""}

        <div class="card-title section-gap">Моё решение</div>
        ${l.submissionFileUrl ? `<div class="small" style="margin-bottom:8px"><a href="${l.submissionFileUrl}" target="_blank" style="color:var(--accent-ink);font-weight:600">📎 Уже загруженный файл</a></div>` : ""}
        <div class="field"><label>Файл или фото решения</label><input type="file" id="sub-file" accept="image/*,.pdf,.doc,.docx" /></div>
        <div class="field"><label>Комментарий</label><textarea id="sub-comment" placeholder="Необязательно">${escapeHTML(l.submissionComment || "")}</textarea></div>
        <button class="btn btn-primary" style="width:100%" onclick="submitHomework('${l.id}')">Отправить</button>
      ` : `<div class="small muted section-gap">Домашнего задания нет</div>`}

      ${l.status === "planned" ? `
        <div class="btn-row section-gap">
          <button class="btn btn-secondary" onclick="requestCancel('${l.id}')">Отменить</button>
          <button class="btn btn-secondary" onclick="openRescheduleOptions('${l.id}')">Перенести</button>
        </div>
      ` : ""}
    `);
  };

  window.submitHomework = async function (lessonId) {
    const l = state.studentLessons.find((x) => x.id === lessonId);
    if (!l) return;
    const file = document.getElementById("sub-file")?.files?.[0];
    const comment = document.getElementById("sub-comment").value.trim();
    let submissionFileUrl = l.submissionFileUrl;
    if (file) {
      const url = await uploadLessonFile(lessonId, "submission", file);
      if (url) submissionFileUrl = url;
    }
    const { error } = await sbClient.from("lessons").update({
      submission_file_url: submissionFileUrl, submission_comment: comment,
    }).eq("id", lessonId);
    if (error) { console.error(error); showToast("Не удалось отправить"); return; }
    l.submissionFileUrl = submissionFileUrl;
    l.submissionComment = comment;
    showToast("Решение отправлено репетитору");
    closeModal();
    render();
  };

  window.studentLinkSelf = async function () {
    const code = document.getElementById("s-code").value.trim();
    if (!code) { showToast("Введите код"); return; }
    const { error } = await sbClient.rpc("link_student_to_record", { p_code: code });
    if (error) { showToast("Код не найден, проверьте у репетитора"); return; }
    await dbFetchAllStudent();
    showToast("Готово!");
    render();
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
      // Токен обновился в фоне (например, при переключении вкладок) — сессия
      // остаётся той же самой, данные не устарели, перезагружать их и
      // перерисовывать экран не нужно. Раньше это происходило при каждой
      // такой фоновой проверке, из-за чего экран иногда «откатывался»
      // при обычной навигации между разделами.
      if (event === "TOKEN_REFRESHED") { return; }
      // Важно: НЕ делать supabase-запросы напрямую внутри этого колбэка —
      // это может подвесить внутреннюю блокировку авторизации в supabase-js.
      // Поэтому выносим дальнейшую загрузку данных за пределы колбэка.
      setTimeout(async () => {
        if (session) {
          await loadForCurrentRole();
        } else {
          resetAllState();
        }
        render();
      }, 0);
    });
  }
  init();
})();
