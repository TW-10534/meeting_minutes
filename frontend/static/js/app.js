/* ═══════════════════════════════════════════════════════════════════════════
   MM Zettai — Frontend Application
   Complete SPA with routing, auth, dashboard, meeting room, and minutes.
   ═══════════════════════════════════════════════════════════════════════════ */

const App = {
    state: {
        token: localStorage.getItem("mm_token"),
        user: JSON.parse(localStorage.getItem("mm_user") || "null"),
        currentPage: "dashboard",
        meetings: [],
        currentMeeting: null,
        calendarYear: new Date().getFullYear(),
        calendarMonth: new Date().getMonth(),
        tunnelUrl: null,
    },
    LANG_NAMES: { en: "English", ja: "Japanese", zh: "Chinese" },
    AVATAR_COLORS: ["avatar-1", "avatar-2", "avatar-3", "avatar-4", "avatar-5", "avatar-6"],
};

/* ─── Initialization ─────────────────────────────────────────────────────── */

App.fetchTunnelUrl = function () {
    return fetch("/tunnel-url").then(function (r) { return r.json(); }).then(function (data) {
        if (data.url) {
            App.state.tunnelUrl = data.url;
        }
        return data.url;
    }).catch(function () { return null; });
};

App.getShareBaseUrl = function () {
    return App.state.tunnelUrl || window.location.origin;
};

App.init = function () {
    // Apply saved theme
    var savedTheme = localStorage.getItem("mm_theme") || "dark";
    document.documentElement.setAttribute("data-theme", savedTheme);

    if (App.state.token && App.state.user) {
        App.showApp();
        App.Dashboard.load();
    } else {
        App.showLogin();
    }

    // Poll for Cloudflare tunnel URL until it's ready
    (function pollTunnel() {
        App.fetchTunnelUrl().then(function (url) {
            if (url) {
                console.log("Tunnel URL available:", url);
            } else {
                setTimeout(pollTunnel, 3000);
            }
        });
    })();

    // Handle hash-based routing
    window.addEventListener("hashchange", App.handleRoute);
    App.handleRoute();

    // Spacebar toggle mic
    document.addEventListener("keydown", function (e) {
        if (e.code === "Space" && App.Meeting._inRoom && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
            e.preventDefault();
            App.Meeting.toggleRecording();
        }
    });
};

App.handleRoute = function () {
    var hash = window.location.hash.slice(1) || "/dashboard";
    var parts = hash.split("/").filter(Boolean);

    if (parts[0] === "join" && parts[1]) {
        if (!App.state.token) {
            App._pendingJoin = parts[1];
            App.showLogin();
            return;
        }
        document.getElementById("joinCode").value = parts[1];
        App.navigate("join");
        return;
    }

    if (parts[0] === "minutes" && parts[1]) {
        App.Minutes.loadDetail(parts[1]);
        return;
    }

    var page = parts[0] || "dashboard";
    if (App.state.token) {
        App.navigate(page, true);
    }
};

App.showLogin = function () {
    document.getElementById("login-view").style.display = "flex";
    document.getElementById("app-view").classList.remove("active");
    document.getElementById("meeting-room-view").classList.remove("active");
};

App.showApp = function () {
    document.getElementById("login-view").style.display = "none";
    document.getElementById("app-view").classList.add("active");
    document.getElementById("meeting-room-view").classList.remove("active");
    App.updateUserUI();
    App.Notifications.init();

    if (App._pendingJoin) {
        document.getElementById("joinCode").value = App._pendingJoin;
        App._pendingJoin = null;
        App.navigate("join");
    }
};

App.navigate = function (page, skipHash) {
    if (!skipHash) {
        window.location.hash = "#/" + page;
    }
    App.state.currentPage = page;

    // Hide all pages
    document.querySelectorAll(".page-view").forEach(function (el) { el.classList.remove("active"); });
    var target = document.getElementById("page-" + page);
    if (target) target.classList.add("active");

    // Update nav
    document.querySelectorAll(".nav-item[data-page]").forEach(function (el) {
        el.classList.toggle("active", el.dataset.page === page);
    });

    // Load page data
    if (page === "dashboard") App.Dashboard.load();
    if (page === "users") App.Users.load();
    if (page === "minutes") App.Minutes.loadList();
    if (page === "my-tasks") App.MyTasks.load();
    if (page === "settings") App.Settings.load();
    if (page === "search") App.Search.init();
};

App.updateUserUI = function () {
    var u = App.state.user;
    if (!u) return;
    document.getElementById("userAvatar").textContent = (u.name || "U").charAt(0).toUpperCase();
    document.getElementById("userName").textContent = u.name;
    document.getElementById("userEid").textContent = u.employee_id;
};

/* ─── API Client ─────────────────────────────────────────────────────────── */

App.api = async function (url, options) {
    options = options || {};
    var headers = options.headers || {};
    if (App.state.token) {
        headers["Authorization"] = "Bearer " + App.state.token;
    }
    if (options.json) {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(options.json);
        delete options.json;
    }
    options.headers = headers;
    var resp = await fetch(url, options);
    if (resp.status === 401) {
        App.Auth.logout();
        throw new Error("Session expired");
    }
    var data;
    var ct = resp.headers.get("content-type") || "";
    if (ct.includes("json")) {
        data = await resp.json();
    } else {
        data = await resp.text();
    }
    if (!resp.ok) {
        throw new Error((data && data.detail) || "Request failed");
    }
    return data;
};

/* ─── Utilities ──────────────────────────────────────────────────────────── */

App.Utils = {};

App.Utils.toast = function (message, type) {
    type = type || "info";
    var container = document.getElementById("toastContainer");
    var el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(function () {
        el.classList.add("toast-exit");
        setTimeout(function () { el.remove(); }, 300);
    }, 4000);
};

App.Utils.showLoading = function (text) {
    document.getElementById("loadingText").textContent = text || "Loading...";
    document.getElementById("loadingOverlay").classList.add("active");
};

App.Utils.hideLoading = function () {
    document.getElementById("loadingOverlay").classList.remove("active");
};

App.Utils.formatDate = function (dateStr) {
    if (!dateStr) return "—";
    var d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

App.Utils.formatDateTime = function (dateStr) {
    if (!dateStr) return "—";
    var d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

App.Utils.formatTime = function (dateStr) {
    if (!dateStr) return "";
    var d = new Date(dateStr);
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
};

App.Utils.getAvatarClass = function (id) {
    return App.AVATAR_COLORS[(id || 0) % App.AVATAR_COLORS.length];
};

App.Utils.copyText = function (text) {
    navigator.clipboard.writeText(text).then(function () {
        App.Utils.toast("Copied to clipboard", "success");
    });
};

App.Utils.escapeHtml = function (str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
};

/* ─── Auth Module ────────────────────────────────────────────────────────── */

App.Auth = {};

App.Auth.switchTab = function (tab) {
    document.querySelectorAll(".login-tab").forEach(function (el) {
        el.classList.toggle("active", el.dataset.tab === tab);
    });
    document.getElementById("loginForm").style.display = tab === "login" ? "block" : "none";
    document.getElementById("registerForm").style.display = tab === "register" ? "block" : "none";
};

App.Auth.handleLogin = async function (e) {
    e.preventDefault();
    var btn = document.getElementById("loginBtn");
    btn.disabled = true;
    btn.textContent = "Signing in...";
    try {
        var data = await App.api("/api/auth/login", {
            method: "POST",
            json: {
                employee_id: document.getElementById("loginEmployeeId").value.trim(),
                password: document.getElementById("loginPassword").value,
            }
        });
        App.state.token = data.token;
        App.state.user = data.user;
        localStorage.setItem("mm_token", data.token);
        localStorage.setItem("mm_user", JSON.stringify(data.user));
        App.Utils.toast("Welcome back, " + data.user.name, "success");
        App.showApp();
        App.Dashboard.load();
    } catch (err) {
        App.Utils.toast(err.message || "Login failed", "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "Sign In";
    }
};

App.Auth.handleRegister = async function (e) {
    e.preventDefault();
    var btn = document.getElementById("registerBtn");
    btn.disabled = true;
    btn.textContent = "Creating account...";
    try {
        var data = await App.api("/api/auth/register", {
            method: "POST",
            json: {
                employee_id: document.getElementById("regEmployeeId").value.trim(),
                password: document.getElementById("regPassword").value,
                name: document.getElementById("regName").value.trim(),
                preferred_language: document.getElementById("regLanguage").value,
            }
        });
        App.state.token = data.token;
        App.state.user = data.user;
        localStorage.setItem("mm_token", data.token);
        localStorage.setItem("mm_user", JSON.stringify(data.user));
        App.Utils.toast("Account created successfully!", "success");
        App.showApp();
        App.Dashboard.load();
    } catch (err) {
        App.Utils.toast(err.message || "Registration failed", "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "Create Account";
    }
};

App.Auth.logout = function () {
    App.state.token = null;
    App.state.user = null;
    localStorage.removeItem("mm_token");
    localStorage.removeItem("mm_user");
    if (App.Meeting._ws) {
        App.Meeting._ws.close();
    }
    App.Notifications.destroy();
    App.showLogin();
    App.Utils.toast("Logged out", "info");
};

/* ─── Dashboard Module ───────────────────────────────────────────────────── */

App.Dashboard = {};
App.Dashboard._meetingDates = {};

App.Dashboard.load = async function () {
    try {
        var meetings = await App.api("/api/meetings");
        App.state.meetings = meetings;

        // Stats
        var scheduled = 0, completed = 0;
        App.Dashboard._meetingDates = {};
        meetings.forEach(function (m) {
            if (m.status === "scheduled") scheduled++;
            if (m.status === "completed") completed++;
            var dateKey = (m.scheduled_at || m.created_at || "").slice(0, 10);
            if (dateKey) {
                if (!App.Dashboard._meetingDates[dateKey]) App.Dashboard._meetingDates[dateKey] = [];
                App.Dashboard._meetingDates[dateKey].push(m);
            }
        });
        document.getElementById("statScheduled").textContent = scheduled;
        document.getElementById("statCompleted").textContent = completed;
        document.getElementById("statTotal").textContent = meetings.length;

        App.Dashboard.renderCalendar();
        App.Dashboard.renderUpcoming(meetings);
    } catch (err) {
        console.error("Dashboard load error:", err);
    }
};

App.Dashboard.renderCalendar = function () {
    var year = App.state.calendarYear;
    var month = App.state.calendarMonth;
    var title = new Date(year, month).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    document.getElementById("calendarTitle").textContent = title;

    var grid = document.getElementById("calendarGrid");
    var html = "";

    // Day headers
    var days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    days.forEach(function (d) { html += '<div class="calendar-day-header">' + d + "</div>"; });

    // Get first day of month and total days
    var firstDay = new Date(year, month, 1).getDay(); // 0=Sun
    var startOffset = firstDay === 0 ? 6 : firstDay - 1; // Monday-based
    var totalDays = new Date(year, month + 1, 0).getDate();
    var prevMonthDays = new Date(year, month, 0).getDate();

    var today = new Date();
    var todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");

    // Previous month days
    for (var i = startOffset - 1; i >= 0; i--) {
        var d = prevMonthDays - i;
        html += '<div class="calendar-day other-month">' + d + "</div>";
    }

    // Current month days
    for (var d = 1; d <= totalDays; d++) {
        var dateStr = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
        var classes = "calendar-day";
        if (dateStr === todayStr) classes += " today";
        var dayMeetings = App.Dashboard._meetingDates[dateStr];
        if (dayMeetings) classes += " has-meeting";
        html += '<div class="' + classes + '" data-date="' + dateStr + '">' + d;
        if (dayMeetings && dayMeetings.length > 0) {
            html += '<div class="calendar-tooltip"><div class="calendar-tooltip-title">' +
                dayMeetings.length + ' meeting' + (dayMeetings.length > 1 ? 's' : '') + '</div>';
            dayMeetings.forEach(function (m) {
                var statusCls = "tooltip-status-" + m.status;
                var time = App.Utils.formatTime(m.scheduled_at || m.created_at);
                html += '<div class="calendar-tooltip-item">' +
                    '<span class="calendar-tooltip-status ' + statusCls + '">' + App.Utils.escapeHtml(m.status) + '</span>' +
                    '<span class="calendar-tooltip-name">' + App.Utils.escapeHtml(m.name) + '</span>' +
                    (time ? '<span class="calendar-tooltip-time">' + time + '</span>' : '') +
                    '</div>';
            });
            html += '</div>';
        }
        html += "</div>";
    }

    // Next month days
    var remaining = 42 - (startOffset + totalDays);
    for (var d = 1; d <= remaining; d++) {
        html += '<div class="calendar-day other-month">' + d + "</div>";
    }

    grid.innerHTML = html;

    // Add click handlers for days with meetings
    grid.querySelectorAll(".calendar-day.has-meeting").forEach(function (el) {
        el.addEventListener("click", function () {
            App.Dashboard.openDayDetail(el.dataset.date);
        });
    });
};

App.Dashboard.openDayDetail = function (dateStr) {
    var meetings = App.Dashboard._meetingDates[dateStr];
    if (!meetings || meetings.length === 0) return;

    var dateObj = new Date(dateStr + "T00:00:00");
    var title = dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    document.getElementById("calendarDayDetailTitle").textContent = title;

    var list = document.getElementById("calendarDayDetailList");
    var html = "";
    meetings.forEach(function (m) {
        var statusCls = "status-" + m.status;
        var time = App.Utils.formatTime(m.scheduled_at || m.created_at);
        var hostName = m.host_name || "You";
        html += '<div class="day-detail-card" data-id="' + m.id + '" data-status="' + m.status + '" data-code="' + (m.code || "") + '">' +
            '<div class="day-detail-card-top">' +
            '<span class="day-detail-card-name">' + App.Utils.escapeHtml(m.name) + '</span>' +
            '<span class="meeting-card-status ' + statusCls + '">' + App.Utils.escapeHtml(m.status) + '</span>' +
            '</div>' +
            '<div class="day-detail-card-meta">' +
            (time ? '<span>' + time + '</span>' : '') +
            '<span>Host: ' + App.Utils.escapeHtml(hostName) + '</span>' +
            '</div>' +
            '</div>';
    });
    list.innerHTML = html;

    // Add click handlers
    list.querySelectorAll(".day-detail-card").forEach(function (card) {
        card.addEventListener("click", function () {
            var id = card.dataset.id;
            var status = card.dataset.status;
            var code = card.dataset.code;
            App.Dashboard.closeDayDetail();
            if (status === "completed") {
                App.navigate("minutes");
                setTimeout(function () { App.Minutes.loadDetail(id); }, 100);
            } else if (status === "active") {
                App.Meeting.enterRoom(id, App.state.user.preferred_language || "en");
            } else if (status === "scheduled") {
                App.Dashboard.openMeeting(id, status, code);
            }
        });
    });

    // Highlight selected date
    document.querySelectorAll(".calendar-day").forEach(function (el) {
        el.classList.toggle("selected", el.dataset.date === dateStr);
    });

    var detailEl = document.getElementById("calendarDayDetail");
    detailEl.style.display = "block";
    setTimeout(function () {
        detailEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
};

App.Dashboard.closeDayDetail = function () {
    document.getElementById("calendarDayDetail").style.display = "none";
    document.querySelectorAll(".calendar-day.selected").forEach(function (el) {
        el.classList.remove("selected");
    });
};

App.Dashboard.prevMonth = function () {
    App.state.calendarMonth--;
    if (App.state.calendarMonth < 0) {
        App.state.calendarMonth = 11;
        App.state.calendarYear--;
    }
    App.Dashboard.renderCalendar();
};

App.Dashboard.nextMonth = function () {
    App.state.calendarMonth++;
    if (App.state.calendarMonth > 11) {
        App.state.calendarMonth = 0;
        App.state.calendarYear++;
    }
    App.Dashboard.renderCalendar();
};

App.Dashboard.renderUpcoming = function (meetings) {
    var list = document.getElementById("upcomingList");
    var upcoming = meetings.filter(function (m) {
        return m.status === "scheduled" || m.status === "active";
    }).slice(0, 8);

    if (upcoming.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x1F4C5;</div><h3>No upcoming meetings</h3><p>Create or schedule a meeting to get started</p></div>';
        return;
    }

    list.innerHTML = "";
    upcoming.forEach(function (m) {
        var statusClass = "status-" + m.status;
        var dateStr = App.Utils.formatDateTime(m.scheduled_at || m.created_at);
        var card = document.createElement("div");
        card.className = "meeting-card";
        card.setAttribute("data-id", m.id);
        card.setAttribute("data-status", m.status);
        card.setAttribute("data-code", m.code || "");
        card.innerHTML =
            '<div class="meeting-card-header">' +
            '<span class="meeting-card-name">' + App.Utils.escapeHtml(m.name) + '</span>' +
            '<span class="meeting-card-status ' + statusClass + '">' + App.Utils.escapeHtml(m.status) + '</span>' +
            '</div>' +
            '<div class="meeting-card-meta">' +
            '<span>' + dateStr + '</span>' +
            '<span>Host: ' + App.Utils.escapeHtml(m.host_name || "You") + '</span>' +
            '</div>';
        card.addEventListener("click", function () {
            App.Dashboard.openMeeting(this.dataset.id, this.dataset.status, this.dataset.code);
        });
        list.appendChild(card);
    });

    // Also show recent completed meetings
    var completed = meetings.filter(function (m) { return m.status === "completed"; }).slice(0, 5);
    if (completed.length > 0) {
        var header = document.createElement("div");
        header.style.marginTop = "20px";
        header.innerHTML = '<h3 style="font-size:16px; font-weight:600; margin-bottom:12px; color:var(--text-secondary);">Recent Completed</h3>';
        list.appendChild(header);
        completed.forEach(function (m) {
            var card = document.createElement("div");
            card.className = "meeting-card";
            card.setAttribute("data-id", m.id);
            card.innerHTML =
                '<div class="meeting-card-header">' +
                '<span class="meeting-card-name">' + App.Utils.escapeHtml(m.name) + '</span>' +
                '<span class="meeting-card-status status-completed">completed</span>' +
                '</div>' +
                '<div class="meeting-card-meta">' +
                '<span>' + App.Utils.formatDateTime(m.ended_at || m.created_at) + '</span>' +
                '</div>';
            card.addEventListener("click", function () {
                var mid = this.dataset.id;
                App.navigate("minutes");
                setTimeout(function () { App.Minutes.loadDetail(mid); }, 100);
            });
            list.appendChild(card);
        });
    }
};

App.Dashboard.openMeeting = function (meetingId, status, code) {
    if (status === "active") {
        App.Meeting.enterRoom(meetingId, App.state.user.preferred_language || "en");
    } else if (status === "scheduled") {
        App.Meeting._createdMeetingId = meetingId;
        App.Meeting._createdMeetingCode = code;
        App.navigate("create");
        document.getElementById("inviteLinkBox").classList.add("visible");
        document.getElementById("inviteCodeInput").value = code;
        App.fetchTunnelUrl().then(function () {
            document.getElementById("inviteLinkInput").value = App.getShareBaseUrl() + "/#/join/" + code;
        });
    }
};

/* ─── Meeting Module ─────────────────────────────────────────────────────── */

App.Meeting = {};
App.Meeting._ws = null;
App.Meeting._inRoom = false;
App.Meeting._recording = false;
App.Meeting._mediaRecorder = null;
App.Meeting._audioChunks = [];
App.Meeting._timerInterval = null;
App.Meeting._timerStart = null;
App.Meeting._participants = {};
App.Meeting._isHost = false;
App.Meeting._meetingId = null;
App.Meeting._meetingCode = null;
App.Meeting._language = "en";
App.Meeting._createdMeetingId = null;
App.Meeting._createdMeetingCode = null;
App.Meeting._lastEndedMeetingId = null;

App.Meeting.handleCreate = async function (e) {
    e.preventDefault();
    var name = document.getElementById("createName").value.trim();
    var lang = document.getElementById("createLanguage").value;
    try {
        App.Utils.showLoading("Creating meeting...");
        var meeting = await App.api("/api/meetings", {
            method: "POST",
            json: { name: name, language: lang }
        });
        // Start the meeting immediately
        await App.api("/api/meetings/" + meeting.id + "/start", { method: "POST", json: {} });

        App.Meeting._createdMeetingId = meeting.id;
        App.Meeting._createdMeetingCode = meeting.code;

        document.getElementById("inviteLinkBox").classList.add("visible");
        document.getElementById("inviteCodeInput").value = meeting.code;
        await App.fetchTunnelUrl();
        document.getElementById("inviteLinkInput").value = App.getShareBaseUrl() + "/#/join/" + meeting.code;

        App.Meeting._loadInviteUsers("createInviteUsersList");
        App.Utils.toast("Meeting created: " + meeting.code, "success");
    } catch (err) {
        App.Utils.toast(err.message, "error");
    } finally {
        App.Utils.hideLoading();
    }
};

App.Meeting.handleSchedule = async function (e) {
    e.preventDefault();
    var name = document.getElementById("scheduleName").value.trim();
    var dt = document.getElementById("scheduleDate").value;
    var lang = document.getElementById("scheduleLanguage").value;
    try {
        var meeting = await App.api("/api/meetings", {
            method: "POST",
            json: { name: name, language: lang, scheduled_at: dt }
        });
        App.Meeting._scheduledMeetingId = meeting.id;
        document.getElementById("scheduleInviteLinkBox").classList.add("visible");
        document.getElementById("scheduleInviteCodeInput").value = meeting.code;
        await App.fetchTunnelUrl();
        document.getElementById("scheduleInviteLinkInput").value = App.getShareBaseUrl() + "/#/join/" + meeting.code;
        App.Meeting._loadInviteUsers("scheduleInviteUsersList");
        App.Utils.toast("Meeting scheduled: " + meeting.code, "success");
    } catch (err) {
        App.Utils.toast(err.message, "error");
    }
};

App.Meeting.handleJoin = async function (e) {
    e.preventDefault();
    var code = document.getElementById("joinCode").value.trim().toUpperCase();
    var lang = document.getElementById("joinLanguage").value;
    try {
        App.Utils.showLoading("Joining meeting...");
        var data = await App.api("/api/meetings/join", {
            method: "POST",
            json: { code: code, language: lang }
        });
        App.Meeting.enterRoom(data.meeting_id, lang);
    } catch (err) {
        App.Utils.toast(err.message, "error");
        App.Utils.hideLoading();
    }
};

App.Meeting.enterCreatedMeeting = function () {
    if (!App.Meeting._createdMeetingId) return;
    var lang = document.getElementById("createLanguage").value;
    App.Meeting.enterRoom(App.Meeting._createdMeetingId, lang);
};

App.Meeting.copyInviteLink = function () {
    App.Utils.copyText(document.getElementById("inviteLinkInput").value);
};

App.Meeting.copyInviteCode = function () {
    App.Utils.copyText(document.getElementById("inviteCodeInput").value);
};

App.Meeting.copyCurrentMeetingCode = function () {
    if (App.Meeting._meetingCode) {
        App.Utils.copyText(App.Meeting._meetingCode);
    }
};

App.Meeting.enterRoom = function (meetingId, language) {
    App.Meeting._meetingId = meetingId;
    App.Meeting._language = language;
    App.Meeting._participants = {};
    App.Meeting._inRoom = true;

    // Switch to meeting room view
    document.getElementById("app-view").classList.remove("active");
    document.getElementById("meeting-room-view").classList.add("active");
    document.getElementById("transcriptMessages").innerHTML =
        '<div class="empty-state" id="transcriptEmpty"><div class="empty-state-icon">&#x1F399;</div><h3>Waiting for speech...</h3><p>Press and hold the microphone button or spacebar to speak</p></div>';
    document.getElementById("participantsList").innerHTML = "";
    document.getElementById("pendingList").innerHTML = "";
    document.getElementById("waitingRoomSection").style.display = "none";
    document.getElementById("waitingOverlay").classList.remove("active");

    App.Utils.hideLoading();

    // Connect WebSocket
    App.Meeting._connectWS(meetingId, language);

    // Start timer
    App.Meeting._timerStart = Date.now();
    App.Meeting._timerInterval = setInterval(App.Meeting._updateTimer, 1000);
};

App.Meeting._connectWS = function (meetingId, language) {
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    var wsUrl = protocol + "//" + window.location.host + "/ws/meeting/" + meetingId +
        "?token=" + encodeURIComponent(App.state.token) +
        "&language=" + encodeURIComponent(language);

    var ws = new WebSocket(wsUrl);
    App.Meeting._ws = ws;

    ws.onopen = function () {
        console.log("WebSocket connected");
        App.Meeting._reconnectAttempts = 0;
    };

    ws.onmessage = function (event) {
        var data;
        try { data = JSON.parse(event.data); } catch (e) { return; }
        App.Meeting._handleWSMessage(data);
    };

    ws.onclose = function (event) {
        console.log("WebSocket disconnected", event.code);
        if (App.Meeting._inRoom && event.code !== 1000) {
            App.Utils.toast("Connection lost. Reconnecting...", "error");
            App.Meeting._reconnectAttempts = (App.Meeting._reconnectAttempts || 0) + 1;
            if (App.Meeting._reconnectAttempts <= 5) {
                var delay = Math.min(1000 * Math.pow(2, App.Meeting._reconnectAttempts - 1), 15000);
                setTimeout(function () {
                    if (App.Meeting._inRoom) {
                        App.Meeting._connectWS(meetingId, language);
                    }
                }, delay);
            } else {
                App.Utils.toast("Unable to reconnect. Please rejoin the meeting.", "error");
            }
        }
    };

    ws.onerror = function (err) {
        console.error("WebSocket error:", err);
    };
};

App.Meeting._handleWSMessage = function (data) {
    switch (data.type) {
        case "host_joined":
            App.Meeting._isHost = true;
            document.getElementById("endMeetingBtn").style.display = "inline-flex";
            if (data.participants) {
                data.participants.forEach(function (p) {
                    App.Meeting._addParticipant(p);
                });
            }
            if (data.pendingParticipants && data.pendingParticipants.length > 0) {
                data.pendingParticipants.forEach(function (p) {
                    App.Meeting._addPending(p);
                });
            }
            // Get meeting details for code
            App.api("/api/meetings/" + App.Meeting._meetingId).then(function (m) {
                App.Meeting._meetingCode = m.code;
                document.getElementById("meetingRoomTitle").textContent = m.name;
            });
            break;

        case "approved":
            document.getElementById("waitingOverlay").classList.remove("active");
            App.Utils.toast("You have been approved to join!", "success");
            if (data.participants) {
                data.participants.forEach(function (p) {
                    App.Meeting._addParticipant(p);
                });
            }
            // Get meeting details
            App.api("/api/meetings/" + App.Meeting._meetingId).then(function (m) {
                App.Meeting._meetingCode = m.code;
                document.getElementById("meetingRoomTitle").textContent = m.name;
            });
            break;

        case "waiting":
            document.getElementById("waitingOverlay").classList.add("active");
            break;

        case "rejected":
            App.Utils.toast("Your request to join was declined", "error");
            App.Meeting.leaveMeeting();
            break;

        case "participant_joined":
            App.Meeting._addParticipant(data);
            App.Utils.toast(data.name + " joined the meeting", "info");
            break;

        case "participant_left":
            App.Meeting._removeParticipant(data.userId);
            App.Utils.toast(data.name + " left the meeting", "info");
            break;

        case "participant_list":
            if (data.participants) {
                data.participants.forEach(function (p) {
                    App.Meeting._addParticipant(p);
                });
            }
            break;

        case "pending_participant":
            App.Meeting._addPending(data);
            App.Utils.toast(data.name + " is waiting to join", "info");
            break;

        case "transcript":
            App.Meeting._displayTranscript(data);
            break;

        case "meeting_ended":
            App.Meeting._lastEndedMeetingId = App.Meeting._meetingId;
            App.Meeting._cleanupRoom();
            document.getElementById("meetingEndedSummary").textContent = data.summary || "No summary available.";
            document.getElementById("meetingEndedModal").classList.add("active");
            break;

        case "error":
            App.Utils.toast(data.message, "error");
            break;
    }
};

App.Meeting._addParticipant = function (p) {
    App.Meeting._participants[p.userId] = p;
    App.Meeting._renderParticipants();
};

App.Meeting._removeParticipant = function (userId) {
    delete App.Meeting._participants[userId];
    App.Meeting._renderParticipants();
};

App.Meeting._renderParticipants = function () {
    var list = document.getElementById("participantsList");
    var html = "";
    var count = 0;
    for (var uid in App.Meeting._participants) {
        var p = App.Meeting._participants[uid];
        count++;
        var avatarClass = App.Utils.getAvatarClass(parseInt(uid));
        var initial = (p.name || "?").charAt(0).toUpperCase();
        var langName = App.LANG_NAMES[p.language] || p.language;
        var isHost = parseInt(uid) === App.state.user.id && App.Meeting._isHost;
        html += '<div class="participant-item">' +
            '<div class="participant-avatar ' + avatarClass + '">' + initial + '</div>' +
            '<div class="participant-info">' +
            '<div class="participant-name">' + App.Utils.escapeHtml(p.name) + (parseInt(uid) === App.state.user.id ? " (You)" : "") + '</div>' +
            '<div class="participant-lang">' + langName + '</div>' +
            '</div>' +
            (isHost ? '<span class="participant-host-badge">Host</span>' : '') +
            '</div>';
    }
    list.innerHTML = html;
    document.getElementById("meetingRoomParticipantCount").textContent = count;
    App.Meeting._populateAssigneeDropdown();
};

App.Meeting._addPending = function (p) {
    var section = document.getElementById("waitingRoomSection");
    section.style.display = "block";
    var list = document.getElementById("pendingList");
    var langName = App.LANG_NAMES[p.language] || p.language;
    var el = document.createElement("div");
    el.className = "pending-item";
    el.id = "pending-" + p.userId;
    el.innerHTML =
        '<div class="pending-item-info">' +
        '<div class="pending-item-name">' + App.Utils.escapeHtml(p.name) + '</div>' +
        '<div class="pending-item-lang">' + langName + '</div>' +
        '</div>' +
        '<div class="pending-actions">' +
        '<button class="pending-approve" title="Approve">&#x2713;</button>' +
        '<button class="pending-reject" title="Reject">&#x2717;</button>' +
        '</div>';
    var userId = p.userId;
    el.querySelector(".pending-approve").addEventListener("click", function () {
        App.Meeting.approveParticipant(userId);
    });
    el.querySelector(".pending-reject").addEventListener("click", function () {
        App.Meeting.rejectParticipant(userId);
    });
    list.appendChild(el);
};

App.Meeting.approveParticipant = function (userId) {
    if (App.Meeting._ws && App.Meeting._ws.readyState === WebSocket.OPEN) {
        App.Meeting._ws.send(JSON.stringify({ type: "approve", userId: userId }));
    }
    var el = document.getElementById("pending-" + userId);
    if (el) el.remove();
    if (document.getElementById("pendingList").children.length === 0) {
        document.getElementById("waitingRoomSection").style.display = "none";
    }
};

App.Meeting.rejectParticipant = function (userId) {
    if (App.Meeting._ws && App.Meeting._ws.readyState === WebSocket.OPEN) {
        App.Meeting._ws.send(JSON.stringify({ type: "reject", userId: userId }));
    }
    var el = document.getElementById("pending-" + userId);
    if (el) el.remove();
    if (document.getElementById("pendingList").children.length === 0) {
        document.getElementById("waitingRoomSection").style.display = "none";
    }
};

App.Meeting._displayTranscript = function (data) {
    var container = document.getElementById("transcriptMessages");
    var empty = document.getElementById("transcriptEmpty");
    if (empty) empty.remove();

    var avatarClass = App.Utils.getAvatarClass(data.speakerId);
    var initial = (data.speakerName || "?").charAt(0).toUpperCase();
    var langBadgeClass = "lang-" + (data.originalLanguage || "en");
    var langName = App.LANG_NAMES[data.originalLanguage] || data.originalLanguage;
    var time = App.Utils.formatTime(data.timestamp || new Date().toISOString());

    var mainText = data.displayText || data.originalText;

    // If another language was not translated, show a subtle indicator
    var untranslatedHtml = "";
    if (data.originalLanguage !== App.Meeting._language && data.translated === false) {
        untranslatedHtml = '<span class="transcript-untranslated-badge">untranslated</span>';
    }

    var el = document.createElement("div");
    el.className = "transcript-message";
    el.innerHTML =
        '<div class="transcript-avatar ' + avatarClass + '">' + initial + '</div>' +
        '<div class="transcript-content">' +
        '<div class="transcript-header">' +
        '<span class="transcript-name">' + App.Utils.escapeHtml(data.speakerName) + '</span>' +
        '<span class="transcript-lang-badge ' + langBadgeClass + '">' + langName + '</span>' +
        '<span class="transcript-time">' + time + '</span>' +
        untranslatedHtml +
        '</div>' +
        '<div class="transcript-text">' + App.Utils.escapeHtml(mainText) + '</div>' +
        '</div>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
};

/* ─── Audio Recording ────────────────────────────────────────────────────── */

App.Meeting.toggleRecording = function () {
    if (App.Meeting._recording) {
        App.Meeting.stopRecording();
    } else {
        App.Meeting.startRecording();
    }
};

App.Meeting.startRecording = async function () {
    if (App.Meeting._recording || !App.Meeting._inRoom) return;
    App.Meeting._recording = true;
    document.getElementById("micButton").classList.add("recording");

    try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
        App.Meeting._mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
        App.Meeting._audioChunks = [];

        App.Meeting._mediaRecorder.ondataavailable = function (e) {
            if (e.data.size > 0) App.Meeting._audioChunks.push(e.data);
        };

        App.Meeting._mediaRecorder.onstop = function () {
            stream.getTracks().forEach(function (t) { t.stop(); });
            if (App.Meeting._audioChunks.length > 0) {
                var blob = new Blob(App.Meeting._audioChunks, { type: mimeType });
                App.Meeting._sendAudio(blob);
            }
        };

        App.Meeting._mediaRecorder.start();
    } catch (err) {
        App.Utils.toast("Microphone access denied", "error");
        App.Meeting._recording = false;
        document.getElementById("micButton").classList.remove("recording");
    }
};

App.Meeting.stopRecording = function () {
    if (!App.Meeting._recording) return;
    App.Meeting._recording = false;
    document.getElementById("micButton").classList.remove("recording");
    if (App.Meeting._mediaRecorder && App.Meeting._mediaRecorder.state === "recording") {
        App.Meeting._mediaRecorder.stop();
    }
};

App.Meeting._sendAudio = async function (blob) {
    if (blob.size < 100) return;

    // Send via WebSocket as base64
    var reader = new FileReader();
    reader.onloadend = function () {
        var base64 = reader.result.split(",")[1];
        if (App.Meeting._ws && App.Meeting._ws.readyState === WebSocket.OPEN) {
            App.Meeting._ws.send(JSON.stringify({
                type: "audio",
                data: base64
            }));
        }
    };
    reader.readAsDataURL(blob);
};

App.Meeting._updateTimer = function () {
    if (!App.Meeting._timerStart) return;
    var elapsed = Math.floor((Date.now() - App.Meeting._timerStart) / 1000);
    var h = Math.floor(elapsed / 3600);
    var m = Math.floor((elapsed % 3600) / 60);
    var s = elapsed % 60;
    document.getElementById("meetingRoomTimer").textContent =
        String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
};

App.Meeting.endMeeting = function () {
    if (!App.Meeting._isHost) return;
    if (!confirm("Are you sure you want to end this meeting? This will generate a summary and save all recordings.")) return;

    if (App.Meeting._ws && App.Meeting._ws.readyState === WebSocket.OPEN) {
        App.Meeting._ws.send(JSON.stringify({ type: "end_meeting" }));
    }
};

App.Meeting.leaveMeeting = function () {
    App.Meeting._cleanupRoom();
    App.showApp();
    App.navigate("dashboard");
};

App.Meeting._cleanupRoom = function () {
    App.Meeting._inRoom = false;
    if (App.Meeting._ws) {
        App.Meeting._ws.close();
        App.Meeting._ws = null;
    }
    if (App.Meeting._timerInterval) {
        clearInterval(App.Meeting._timerInterval);
        App.Meeting._timerInterval = null;
    }
    App.Meeting._timerStart = null;
    App.Meeting._participants = {};
    App.Meeting._isHost = false;
    App.Meeting.stopRecording();

    document.getElementById("meeting-room-view").classList.remove("active");
    document.getElementById("endMeetingBtn").style.display = "none";
};

App.Meeting.closeMeetingEndedModal = function () {
    document.getElementById("meetingEndedModal").classList.remove("active");
    App.showApp();
    App.navigate("dashboard");
    App.Dashboard.load();
};

App.Meeting.viewMeetingMinutes = function () {
    document.getElementById("meetingEndedModal").classList.remove("active");
    App.showApp();
    App.navigate("minutes");
    if (App.Meeting._lastEndedMeetingId) {
        setTimeout(function () {
            App.Minutes.loadDetail(App.Meeting._lastEndedMeetingId);
        }, 200);
    }
};

/* ─── Audio Player Module ────────────────────────────────────────────────── */

App.AudioPlayer = {
    _audio: null,
    _chunks: [],       // [{url, blobUrl, duration, start, end}]
    _currentChunk: 0,
    _totalDuration: 0,
    _playing: false,
    _container: null,
    _onTimeUpdate: null,
    _destroyed: false,
};

App.AudioPlayer.init = async function (container, chunkFilenames, onTimeUpdate, meetingId) {
    App.AudioPlayer.destroy();
    App.AudioPlayer._destroyed = false;
    App.AudioPlayer._container = container;
    App.AudioPlayer._onTimeUpdate = onTimeUpdate || null;
    App.AudioPlayer._meetingId = meetingId || null;
    App.AudioPlayer._chunks = [];
    App.AudioPlayer._currentChunk = 0;
    App.AudioPlayer._totalDuration = 0;
    App.AudioPlayer._playing = false;

    // Fetch blobs and detect durations
    var cumulativeStart = 0;
    for (var i = 0; i < chunkFilenames.length; i++) {
        if (App.AudioPlayer._destroyed) return;
        var url = meetingId
            ? "/api/recordings/" + meetingId + "/" + chunkFilenames[i]
            : "/api/recordings/" + chunkFilenames[i];
        try {
            var resp = await fetch(url);
            var blob = await resp.blob();
            var blobUrl = URL.createObjectURL(blob);
            var duration = await App.AudioPlayer._detectDuration(blobUrl);
            App.AudioPlayer._chunks.push({
                url: url,
                blobUrl: blobUrl,
                duration: duration,
                start: cumulativeStart,
                end: cumulativeStart + duration,
            });
            cumulativeStart += duration;
        } catch (e) {
            console.warn("AudioPlayer: failed to load chunk", i, e);
        }
    }
    App.AudioPlayer._totalDuration = cumulativeStart;

    if (App.AudioPlayer._chunks.length === 0 || App.AudioPlayer._destroyed) return;

    // Build UI
    App.AudioPlayer._render(container);
    App.AudioPlayer._loadChunk(0);
};

App.AudioPlayer._detectDuration = function (blobUrl) {
    return new Promise(function (resolve) {
        var tmpAudio = new Audio();
        tmpAudio.preload = "metadata";

        var resolved = false;
        function done(dur) {
            if (resolved) return;
            resolved = true;
            tmpAudio.removeAttribute("src");
            tmpAudio.load();
            resolve(dur);
        }

        tmpAudio.addEventListener("loadedmetadata", function () {
            if (isFinite(tmpAudio.duration) && tmpAudio.duration > 0) {
                done(tmpAudio.duration);
            } else {
                // WebM duration workaround: seek to large time to force browser to calculate
                tmpAudio.currentTime = 1e10;
            }
        });

        tmpAudio.addEventListener("timeupdate", function () {
            if (isFinite(tmpAudio.duration) && tmpAudio.duration > 0) {
                done(tmpAudio.duration);
            }
        });

        tmpAudio.addEventListener("error", function () { done(0); });
        setTimeout(function () { done(tmpAudio.duration > 0 && isFinite(tmpAudio.duration) ? tmpAudio.duration : 5); }, 5000);

        tmpAudio.src = blobUrl;
    });
};

App.AudioPlayer._render = function (container) {
    container.innerHTML =
        '<div class="custom-audio-player">' +
            '<div class="audio-subtitle-bar" id="audioSubtitleBar">Ready to play</div>' +
            '<div class="audio-controls-row">' +
                '<button class="audio-play-btn" id="audioPlayBtn" onclick="App.AudioPlayer.togglePlay()">&#9654;</button>' +
                '<div class="audio-progress-container" id="audioProgressContainer">' +
                    '<div class="audio-progress-bar" id="audioProgressBar" style="width:0%"></div>' +
                '</div>' +
                '<span class="audio-time" id="audioTimeDisplay">0:00 / ' + App.AudioPlayer._formatTime(App.AudioPlayer._totalDuration) + '</span>' +
            '</div>' +
        '</div>';

    // Seek on progress bar click
    document.getElementById("audioProgressContainer").addEventListener("click", function (e) {
        var rect = this.getBoundingClientRect();
        var pct = (e.clientX - rect.left) / rect.width;
        pct = Math.max(0, Math.min(1, pct));
        App.AudioPlayer.seekToGlobal(pct * App.AudioPlayer._totalDuration);
    });
};

App.AudioPlayer._loadChunk = function (index) {
    if (index < 0 || index >= App.AudioPlayer._chunks.length) return;
    App.AudioPlayer._currentChunk = index;

    if (App.AudioPlayer._audio) {
        App.AudioPlayer._audio.pause();
        App.AudioPlayer._audio.removeAttribute("src");
        App.AudioPlayer._audio.load();
    }

    var audio = new Audio();
    audio.preload = "auto";
    audio.src = App.AudioPlayer._chunks[index].blobUrl;

    audio.addEventListener("timeupdate", App.AudioPlayer._handleTimeUpdate);
    audio.addEventListener("ended", App.AudioPlayer._handleEnded);

    App.AudioPlayer._audio = audio;
};

App.AudioPlayer._handleTimeUpdate = function () {
    var chunk = App.AudioPlayer._chunks[App.AudioPlayer._currentChunk];
    if (!chunk) return;
    var globalTime = chunk.start + App.AudioPlayer._audio.currentTime;
    var pct = (globalTime / App.AudioPlayer._totalDuration) * 100;

    var bar = document.getElementById("audioProgressBar");
    var timeDisplay = document.getElementById("audioTimeDisplay");
    if (bar) bar.style.width = pct + "%";
    if (timeDisplay) timeDisplay.textContent = App.AudioPlayer._formatTime(globalTime) + " / " + App.AudioPlayer._formatTime(App.AudioPlayer._totalDuration);

    if (App.AudioPlayer._onTimeUpdate) {
        App.AudioPlayer._onTimeUpdate(globalTime);
    }
};

App.AudioPlayer._handleEnded = function () {
    var nextIndex = App.AudioPlayer._currentChunk + 1;
    if (nextIndex < App.AudioPlayer._chunks.length) {
        App.AudioPlayer._loadChunk(nextIndex);
        App.AudioPlayer._audio.play();
    } else {
        App.AudioPlayer._playing = false;
        var btn = document.getElementById("audioPlayBtn");
        if (btn) btn.innerHTML = "&#9654;";
    }
};

App.AudioPlayer.togglePlay = function () {
    if (!App.AudioPlayer._audio) return;
    if (App.AudioPlayer._playing) {
        App.AudioPlayer._audio.pause();
        App.AudioPlayer._playing = false;
        document.getElementById("audioPlayBtn").innerHTML = "&#9654;";
    } else {
        App.AudioPlayer._audio.play();
        App.AudioPlayer._playing = true;
        document.getElementById("audioPlayBtn").innerHTML = "&#10074;&#10074;";
    }
};

App.AudioPlayer.seekToGlobal = function (globalTime) {
    globalTime = Math.max(0, Math.min(globalTime, App.AudioPlayer._totalDuration));
    for (var i = 0; i < App.AudioPlayer._chunks.length; i++) {
        var c = App.AudioPlayer._chunks[i];
        if (globalTime >= c.start && globalTime < c.end) {
            var wasPlaying = App.AudioPlayer._playing;
            if (i !== App.AudioPlayer._currentChunk) {
                App.AudioPlayer._loadChunk(i);
            }
            App.AudioPlayer._audio.currentTime = globalTime - c.start;
            if (wasPlaying) {
                App.AudioPlayer._audio.play();
                App.AudioPlayer._playing = true;
            }
            App.AudioPlayer._handleTimeUpdate();
            return;
        }
    }
    // If globalTime is exactly at the end, seek to last chunk end
    if (App.AudioPlayer._chunks.length > 0) {
        var last = App.AudioPlayer._chunks.length - 1;
        App.AudioPlayer._loadChunk(last);
        App.AudioPlayer._audio.currentTime = App.AudioPlayer._chunks[last].duration;
        App.AudioPlayer._handleTimeUpdate();
    }
};

App.AudioPlayer.getCurrentChunkIndex = function () {
    return App.AudioPlayer._currentChunk;
};

App.AudioPlayer._formatTime = function (secs) {
    if (!isFinite(secs) || secs < 0) secs = 0;
    var m = Math.floor(secs / 60);
    var s = Math.floor(secs % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
};

App.AudioPlayer.destroy = function () {
    App.AudioPlayer._destroyed = true;
    if (App.AudioPlayer._audio) {
        App.AudioPlayer._audio.pause();
        App.AudioPlayer._audio.removeAttribute("src");
        App.AudioPlayer._audio.load();
        App.AudioPlayer._audio = null;
    }
    App.AudioPlayer._chunks.forEach(function (c) {
        if (c.blobUrl) {
            try { URL.revokeObjectURL(c.blobUrl); } catch (e) {}
        }
    });
    App.AudioPlayer._chunks = [];
    App.AudioPlayer._playing = false;
    App.AudioPlayer._currentChunk = 0;
    App.AudioPlayer._totalDuration = 0;
};


/* ─── Minutes Module ─────────────────────────────────────────────────────── */

App.Minutes = {};

App.Minutes._currentMeetingId = null;
App.Minutes._currentMeeting = null;
App.Minutes._transcripts = [];
App.Minutes._meetingStartedAt = null;

App.Minutes.loadList = async function () {
    try {
        var meetings = await App.api("/api/meetings");
        var completed = meetings.filter(function (m) { return m.status === "completed"; });
        var list = document.getElementById("minutesList");

        if (completed.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x1F4DD;</div><h3>No meeting minutes yet</h3><p>Completed meetings will appear here with summaries and recordings</p></div>';
            return;
        }

        list.innerHTML = "";
        completed.forEach(function (m) {
            var card = document.createElement("div");
            card.className = "minutes-card";
            card.setAttribute("data-id", m.id);
            card.innerHTML =
                '<div class="minutes-card-header">' +
                '<span class="minutes-card-name">' + App.Utils.escapeHtml(m.name) + '</span>' +
                '<span class="minutes-card-date">' + App.Utils.formatDateTime(m.ended_at || m.created_at) + '</span>' +
                '</div>' +
                '<div class="minutes-card-meta">' +
                '<span>Host: ' + App.Utils.escapeHtml(m.host_name || "\u2014") + '</span>' +
                '<span>Code: ' + App.Utils.escapeHtml(m.code || "\u2014") + '</span>' +
                '</div>';
            card.addEventListener("click", function () {
                App.Minutes.loadDetail(this.dataset.id);
            });
            list.appendChild(card);
        });
    } catch (err) {
        App.Utils.toast("Failed to load meeting minutes", "error");
    }
};

App.Minutes.loadDetail = async function (meetingId) {
    try {
        App.Utils.showLoading("Loading meeting minutes...");
        App.AudioPlayer.destroy();

        App.Minutes._currentMeetingId = meetingId;

        var meeting = await App.api("/api/meetings/" + meetingId);
        App.Minutes._currentMeeting = meeting;
        var transcriptData = await App.api("/api/meetings/" + meetingId + "/transcripts");
        var transcripts = transcriptData.transcripts || transcriptData;
        App.Minutes._transcripts = transcripts;
        App.Minutes._meetingStartedAt = meeting.started_at || meeting.created_at;

        // Show detail page
        document.querySelectorAll(".page-view").forEach(function (el) { el.classList.remove("active"); });
        document.getElementById("page-minutes-detail").classList.add("active");

        document.getElementById("minutesDetailTitle").textContent = meeting.name;
        document.getElementById("minutesDetailSubtitle").textContent =
            App.Utils.formatDateTime(meeting.ended_at || meeting.created_at) + " | " +
            (meeting.participants ? meeting.participants.length : 0) + " participants";

        var content = document.getElementById("minutesDetailContent");
        var html = "";

        // 1. Summary section with regenerate button
        var isHost = App.state.user && meeting.host_id === App.state.user.id;
        html += '<div class="minutes-summary">' +
            '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">' +
            '<h3 style="margin-bottom:0;">AI-Generated Summary</h3>' +
            (isHost ? '<div style="display:flex;align-items:center;gap:8px;" id="regenerateControls">' +
                '<select id="regenerateLangSelect" class="form-control" style="width:auto;padding:4px 8px;font-size:12px;">' +
                '<option value="en">English</option>' +
                '<option value="ja">Japanese</option>' +
                '<option value="zh">Chinese</option>' +
                '</select>' +
                '<button class="btn btn-secondary btn-sm" onclick="App.Minutes.regenerateSummary(\'' + meetingId + '\')" id="regenerateSummaryBtn">Regenerate Summary</button>' +
                '</div>' : '') +
            '</div>' +
            '<div class="minutes-summary-content" id="minutesSummaryContent">' +
            App.Utils.escapeHtml(meeting.summary || "No summary available.") +
            '</div></div>';

        // 2. Recording section (placeholder, populated async)
        html += '<div class="minutes-recording-section" id="minutesRecordingSection" style="display:none;">' +
            '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">' +
            '<h3 style="margin-bottom:0;">Meeting Recording</h3>' +
            '<button class="btn btn-secondary btn-sm" id="downloadRecordingBtn" onclick="App.Minutes.downloadRecording()" style="display:none;">&#x1F4BE; Download Recording</button>' +
            '</div>' +
            '<div id="audioPlayerContainer"></div>' +
            '</div>';

        // 3. Transcript section (collapsible)
        if (transcripts.length > 0) {
            html += '<div class="minutes-transcript-section">' +
                '<div class="transcript-toggle-header" onclick="App.Minutes.toggleTranscript()">' +
                '<span class="transcript-toggle-icon" id="transcriptToggleIcon">&#9654;</span>' +
                '<h3 style="margin-bottom:0;">Show Transcript</h3>' +
                '<span class="transcript-toggle-count">' + transcripts.length + ' entries</span>' +
                '</div>' +
                '<div class="transcript-collapsible" id="transcriptCollapsible" style="display:none;">';

            var canEdit = isHost || (App.state.user && App.state.user.employee_id === "10534");
            transcripts.forEach(function (t, idx) {
                var avatarClass = App.Utils.getAvatarClass(t.speaker_id);
                var initial = (t.speaker_name || "?").charAt(0).toUpperCase();
                var langBadge = "lang-" + (t.original_language || "en");
                var langName = App.LANG_NAMES[t.original_language] || t.original_language;
                var editBtn = canEdit ? '<button class="transcript-edit-btn" onclick="App.Minutes.editTranscript(' + t.id + ', ' + idx + ')" title="Edit">&#x270F;</button>' : '';

                html += '<div class="transcript-message minutes-transcript-entry" data-index="' + idx + '" data-tid="' + t.id + '">' +
                    '<div class="transcript-avatar ' + avatarClass + '">' + initial + '</div>' +
                    '<div class="transcript-content">' +
                    '<div class="transcript-header">' +
                    '<span class="transcript-name" id="transcript-name-' + idx + '">' + App.Utils.escapeHtml(t.speaker_name) + '</span>' +
                    '<span class="transcript-lang-badge ' + langBadge + '">' + langName + '</span>' +
                    '<span class="transcript-time">' + App.Utils.formatTime(t.timestamp) + '</span>' +
                    editBtn +
                    '</div>' +
                    '<div class="transcript-text" id="transcript-text-' + idx + '">' + App.Utils.escapeHtml(t.original_text) + '</div>';

                if (t.translations) {
                    for (var lang in t.translations) {
                        html += '<div class="transcript-translation">[' +
                            (App.LANG_NAMES[lang] || lang) + '] ' +
                            App.Utils.escapeHtml(t.translations[lang]) + '</div>';
                    }
                }
                html += '</div></div>';
            });
            html += '</div></div>';
        }

        content.innerHTML = html;
        window.location.hash = "#/minutes/" + meetingId;

        // Load action items for minutes page
        App.Minutes._loadActionItems(meetingId);

        // Load chat messages and notes for minutes page
        App.Minutes._loadChatAndNotes(meetingId, meeting);

        // Load recordings asynchronously
        App.Minutes._initRecordingPlayer(meetingId, meeting);

    } catch (err) {
        App.Utils.toast("Failed to load meeting details", "error");
    } finally {
        App.Utils.hideLoading();
    }
};

App.Minutes._initRecordingPlayer = async function (meetingId, meeting) {
    try {
        var recordings = await App.api("/api/meetings/" + meetingId + "/recording");
        if (recordings.chunks && recordings.chunks.length > 0) {
            App.Minutes._recordingChunks = recordings.chunks;
            App.Minutes._recordingMeetingId = recordings.meeting_id || meetingId;
            var section = document.getElementById("minutesRecordingSection");
            if (section) section.style.display = "";
            var dlBtn = document.getElementById("downloadRecordingBtn");
            if (dlBtn) dlBtn.style.display = "";
            var playerContainer = document.getElementById("audioPlayerContainer");
            if (playerContainer) {
                await App.AudioPlayer.init(
                    playerContainer,
                    recordings.chunks,
                    function (globalTime) {
                        App.Minutes._highlightTranscriptAtTime(globalTime);
                    },
                    recordings.meeting_id || meetingId
                );
            }
        }
    } catch (e) {
        // No recordings available
    }
};

App.Minutes._recordingChunks = [];
App.Minutes._recordingMeetingId = null;

App.Minutes.downloadRecording = async function () {
    var chunks = App.Minutes._recordingChunks;
    var mid = App.Minutes._recordingMeetingId;
    if (!chunks || chunks.length === 0) {
        App.Utils.toast("No recordings available", "error");
        return;
    }

    var btn = document.getElementById("downloadRecordingBtn");
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Downloading...";
    }

    try {
        // Fetch all chunks and combine into a single blob
        var blobParts = [];
        for (var i = 0; i < chunks.length; i++) {
            var url = mid
                ? "/api/recordings/" + mid + "/" + chunks[i]
                : "/api/recordings/" + chunks[i];
            var resp = await fetch(url);
            var blob = await resp.blob();
            blobParts.push(blob);
        }

        var combined = new Blob(blobParts, { type: "audio/webm" });
        var meetingName = (App.Minutes._currentMeeting && App.Minutes._currentMeeting.name) || "recording";
        var filename = meetingName.replace(/[^a-zA-Z0-9_\- ]/g, "_") + ".webm";

        var downloadUrl = URL.createObjectURL(combined);
        var a = document.createElement("a");
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(downloadUrl);
        }, 100);
        App.Utils.toast("Recording downloaded", "success");
    } catch (err) {
        App.Utils.toast("Download failed: " + err.message, "error");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = "&#x1F4BE; Download Recording";
        }
    }
};

App.Minutes._highlightTranscriptAtTime = function (globalTime) {
    var transcripts = App.Minutes._transcripts;
    var startedAt = App.Minutes._meetingStartedAt;
    if (!transcripts || !transcripts.length || !startedAt) return;

    var meetingStart = new Date(startedAt).getTime() / 1000;
    var activeIndex = -1;

    // Find transcript whose time window contains the current global time
    for (var i = 0; i < transcripts.length; i++) {
        var tTime = new Date(transcripts[i].timestamp).getTime() / 1000;
        var offset = tTime - meetingStart;
        var nextOffset = (i + 1 < transcripts.length)
            ? (new Date(transcripts[i + 1].timestamp).getTime() / 1000 - meetingStart)
            : App.AudioPlayer._totalDuration;

        if (globalTime >= offset && globalTime < nextOffset) {
            activeIndex = i;
            break;
        }
    }

    // Fallback: use chunk index as transcript index
    if (activeIndex < 0 && transcripts.length > 0) {
        activeIndex = Math.min(App.AudioPlayer.getCurrentChunkIndex(), transcripts.length - 1);
    }

    // Update subtitle bar
    var subtitleBar = document.getElementById("audioSubtitleBar");
    if (subtitleBar && activeIndex >= 0) {
        var t = transcripts[activeIndex];
        subtitleBar.textContent = (t.speaker_name || "Unknown") + ": " + t.original_text;
    }

    // Highlight active transcript entry
    var entries = document.querySelectorAll(".minutes-transcript-entry");
    entries.forEach(function (el) { el.classList.remove("transcript-active"); });
    if (activeIndex >= 0) {
        var activeEl = document.querySelector('.minutes-transcript-entry[data-index="' + activeIndex + '"]');
        if (activeEl) {
            activeEl.classList.add("transcript-active");
            // Auto-scroll if transcript section is visible
            var collapsible = document.getElementById("transcriptCollapsible");
            if (collapsible && collapsible.style.display !== "none") {
                activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
        }
    }
};

App.Minutes.toggleTranscript = function () {
    var collapsible = document.getElementById("transcriptCollapsible");
    var icon = document.getElementById("transcriptToggleIcon");
    if (!collapsible) return;
    if (collapsible.style.display === "none") {
        collapsible.style.display = "";
        if (icon) icon.innerHTML = "&#9660;";
    } else {
        collapsible.style.display = "none";
        if (icon) icon.innerHTML = "&#9654;";
    }
};

App.Minutes.regenerateSummary = async function (meetingId) {
    var btn = document.getElementById("regenerateSummaryBtn");
    var langSelect = document.getElementById("regenerateLangSelect");
    var lang = langSelect ? langSelect.value : "en";
    var langName = App.LANG_NAMES[lang] || lang;

    if (btn) {
        btn.disabled = true;
        btn.textContent = "Generating...";
    }
    if (langSelect) langSelect.disabled = true;

    try {
        var result = await App.api("/api/meetings/" + meetingId + "/regenerate-summary", {
            method: "POST",
            json: { language: lang }
        });
        var summaryEl = document.getElementById("minutesSummaryContent");
        if (summaryEl) {
            summaryEl.textContent = result.summary || "No summary generated.";
        }
        App.Utils.toast("Summary regenerated in " + langName, "success");
    } catch (err) {
        App.Utils.toast("Failed to regenerate summary: " + err.message, "error");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Regenerate Summary";
        }
        if (langSelect) langSelect.disabled = false;
    }
};

App.Minutes.deleteMeeting = async function () {
    var meetingId = App.Minutes._currentMeetingId;
    if (!meetingId) return;
    var meeting = App.Minutes._currentMeeting;
    var name = meeting ? meeting.name : "this meeting";
    if (!confirm("Delete \"" + name + "\"? This will permanently remove all transcripts, recordings, chat messages, and action items. This cannot be undone.")) {
        return;
    }
    try {
        await App.api("/api/meetings/" + meetingId, { method: "DELETE" });
        App.Utils.toast("Meeting deleted", "success");
        App.AudioPlayer.destroy();
        App.navigate("minutes");
    } catch (err) {
        App.Utils.toast("Failed to delete: " + err.message, "error");
    }
};

/* ─── Users Module ───────────────────────────────────────────────────────── */

App.Users = {};

App.Users._isSuperAdmin = function () {
    return App.state.user && App.state.user.employee_id === "10534";
};

App.Users.load = async function () {
    var container = document.getElementById("usersList");
    container.innerHTML = '<div class="empty-state"><div class="waiting-spinner"></div><p>Loading users...</p></div>';
    try {
        var users = await App.api("/api/users");
        if (!users.length) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x1F465;</div><h3>No users found</h3><p>No registered users yet.</p></div>';
            return;
        }
        var isAdmin = App.Users._isSuperAdmin();
        var html = '';
        users.forEach(function (u) {
            var initial = (u.name || "U").charAt(0).toUpperCase();
            var colorClass = App.AVATAR_COLORS[u.id % App.AVATAR_COLORS.length];
            var langName = App.LANG_NAMES[u.preferred_language] || u.preferred_language;
            var isSelf = App.state.user && u.id === App.state.user.id;
            html += '<div class="user-card" id="user-card-' + u.id + '">' +
                '<div class="user-card-avatar ' + colorClass + '">' + initial + '</div>' +
                '<div class="user-card-info">' +
                    '<div class="user-card-name">' + App.Utils.escapeHtml(u.name) + (isSelf ? ' <span class="user-you-badge">You</span>' : '') + '</div>' +
                    '<div class="user-card-meta">ID: ' + App.Utils.escapeHtml(u.employee_id) + ' &middot; ' + langName + '</div>' +
                '</div>' +
                (isAdmin && !isSelf ? '<button class="btn btn-danger btn-sm user-delete-btn" onclick="App.Users.deleteUser(' + u.id + ', \'' + App.Utils.escapeHtml(u.name).replace(/'/g, "\\'") + '\')">Delete</button>' : '') +
            '</div>';
        });
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = '<div class="empty-state"><h3>Failed to load users</h3><p>' + err.message + '</p></div>';
    }
};

App.Users.deleteUser = async function (userId, userName) {
    if (!confirm("Delete user \"" + userName + "\"? This will remove all their meetings, transcripts, and data. This cannot be undone.")) {
        return;
    }
    try {
        await App.api("/api/users/" + userId, { method: "DELETE" });
        var card = document.getElementById("user-card-" + userId);
        if (card) card.remove();
        App.Utils.toast("User \"" + userName + "\" deleted", "success");
    } catch (err) {
        App.Utils.toast("Failed to delete user: " + err.message, "error");
    }
};

/* ─── Invite Users Logic ────────────────────────────────────────────────── */

App.Meeting._loadInviteUsers = async function (listId) {
    var container = document.getElementById(listId);
    if (!container) return;
    container.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">Loading users...</span>';
    try {
        var users = await App.api("/api/users");
        var html = '';
        users.forEach(function (u) {
            if (App.state.user && u.id === App.state.user.id) return;
            var initial = (u.name || "U").charAt(0).toUpperCase();
            var colorClass = App.AVATAR_COLORS[u.id % App.AVATAR_COLORS.length];
            var langName = App.LANG_NAMES[u.preferred_language] || u.preferred_language;
            html += '<label class="invite-user-item">' +
                '<input type="checkbox" value="' + u.id + '" class="invite-user-checkbox">' +
                '<div class="invite-user-avatar ' + colorClass + '">' + initial + '</div>' +
                '<div class="invite-user-info">' +
                    '<div class="invite-user-name">' + App.Utils.escapeHtml(u.name) + '</div>' +
                    '<div class="invite-user-meta">' + langName + '</div>' +
                '</div>' +
            '</label>';
        });
        if (!html) {
            container.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">No other users to invite.</span>';
        } else {
            container.innerHTML = html;
        }
    } catch (err) {
        container.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">Could not load users.</span>';
    }
};

App.Meeting.inviteSelected = async function (source) {
    var listId = source === "create" ? "createInviteUsersList" : "scheduleInviteUsersList";
    var meetingId = source === "create" ? App.Meeting._createdMeetingId : App.Meeting._scheduledMeetingId;
    if (!meetingId) {
        App.Utils.toast("No meeting to invite to", "error");
        return;
    }
    var checkboxes = document.querySelectorAll("#" + listId + " .invite-user-checkbox:checked");
    var userIds = [];
    checkboxes.forEach(function (cb) { userIds.push(parseInt(cb.value)); });
    if (!userIds.length) {
        App.Utils.toast("Select at least one user", "error");
        return;
    }
    try {
        var result = await App.api("/api/meetings/" + meetingId + "/invite", {
            method: "POST",
            json: { user_ids: userIds }
        });
        var count = result.invited ? result.invited.length : 0;
        App.Utils.toast(count + " user(s) invited successfully", "success");
        // Uncheck all
        checkboxes.forEach(function (cb) { cb.checked = false; });
    } catch (err) {
        App.Utils.toast(err.message, "error");
    }
};

/* ─── Settings Module ────────────────────────────────────────────────────── */

App.Settings = {};

App.Settings.load = function () {
    var u = App.state.user;
    if (!u) return;
    document.getElementById("settingsName").value = u.name || "";
    document.getElementById("settingsLanguage").value = u.preferred_language || "en";
    App.Settings._updateThemeButtons();
};

App.Settings.setTheme = function (theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("mm_theme", theme);
    App.Settings._updateThemeButtons();
    App.Utils.toast("Theme set to " + theme, "success");
};

App.Settings._updateThemeButtons = function () {
    var current = localStorage.getItem("mm_theme") || "dark";
    var darkBtn = document.getElementById("themeDarkBtn");
    var lightBtn = document.getElementById("themeLightBtn");
    if (darkBtn && lightBtn) {
        darkBtn.className = current === "dark" ? "btn btn-primary" : "btn btn-secondary";
        lightBtn.className = current === "light" ? "btn btn-primary" : "btn btn-secondary";
    }
};

App.Settings.saveProfile = async function (e) {
    e.preventDefault();
    try {
        await App.api("/api/auth/settings", {
            method: "PUT",
            json: {
                name: document.getElementById("settingsName").value.trim(),
                preferred_language: document.getElementById("settingsLanguage").value,
            }
        });
        App.state.user.name = document.getElementById("settingsName").value.trim();
        App.state.user.preferred_language = document.getElementById("settingsLanguage").value;
        localStorage.setItem("mm_user", JSON.stringify(App.state.user));
        App.updateUserUI();
        App.Utils.toast("Profile updated", "success");
    } catch (err) {
        App.Utils.toast(err.message, "error");
    }
};

App.Settings.changePassword = async function (e) {
    e.preventDefault();
    var currentPw = document.getElementById("settingsCurrentPw").value;
    var newPw = document.getElementById("settingsNewPw").value;
    if (!currentPw || !newPw) {
        App.Utils.toast("Both fields are required", "error");
        return;
    }
    if (newPw.length < 4) {
        App.Utils.toast("Password must be at least 4 characters", "error");
        return;
    }
    try {
        await App.api("/api/auth/settings", {
            method: "PUT",
            json: {
                current_password: currentPw,
                new_password: newPw,
            }
        });
        document.getElementById("settingsCurrentPw").value = "";
        document.getElementById("settingsNewPw").value = "";
        App.Utils.toast("Password updated", "success");
    } catch (err) {
        App.Utils.toast(err.message, "error");
    }
};

/* ─── Transcript Editing ────────────────────────────────────────────────── */

App.Minutes.editTranscript = function (transcriptId, idx) {
    var textEl = document.getElementById("transcript-text-" + idx);
    var nameEl = document.getElementById("transcript-name-" + idx);
    if (!textEl || !nameEl) return;

    var currentText = App.Minutes._transcripts[idx].original_text;
    var currentName = App.Minutes._transcripts[idx].speaker_name;

    textEl.innerHTML =
        '<div class="transcript-edit-area">' +
        '<label style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:block;">Speaker Name</label>' +
        '<input type="text" class="form-input" id="transcript-edit-name-' + idx + '" value="' + App.Utils.escapeHtml(currentName).replace(/"/g, '&quot;') + '" style="margin-bottom:8px;padding:6px 10px;font-size:13px;">' +
        '<label style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:block;">Text</label>' +
        '<textarea class="form-input" id="transcript-edit-text-' + idx + '" rows="3" style="resize:vertical;padding:8px 10px;font-size:13px;">' + App.Utils.escapeHtml(currentText) + '</textarea>' +
        '<div class="transcript-edit-actions">' +
        '<button class="btn btn-primary btn-sm" onclick="App.Minutes.saveTranscriptEdit(' + transcriptId + ', ' + idx + ')">Save</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="App.Minutes.cancelTranscriptEdit(' + idx + ')">Cancel</button>' +
        '</div></div>';
};

App.Minutes.saveTranscriptEdit = async function (transcriptId, idx) {
    var textInput = document.getElementById("transcript-edit-text-" + idx);
    var nameInput = document.getElementById("transcript-edit-name-" + idx);
    if (!textInput || !nameInput) return;

    var newText = textInput.value.trim();
    var newName = nameInput.value.trim();
    if (!newText) { App.Utils.toast("Text cannot be empty", "error"); return; }
    if (!newName) { App.Utils.toast("Name cannot be empty", "error"); return; }

    try {
        await App.api("/api/transcripts/" + transcriptId, {
            method: "PUT",
            json: { original_text: newText, speaker_name: newName }
        });
        App.Minutes._transcripts[idx].original_text = newText;
        App.Minutes._transcripts[idx].speaker_name = newName;
        var textEl = document.getElementById("transcript-text-" + idx);
        var nameEl = document.getElementById("transcript-name-" + idx);
        if (textEl) textEl.textContent = newText;
        if (nameEl) nameEl.textContent = newName;
        App.Utils.toast("Transcript updated", "success");
    } catch (err) {
        App.Utils.toast("Failed to save: " + err.message, "error");
    }
};

App.Minutes.cancelTranscriptEdit = function (idx) {
    var textEl = document.getElementById("transcript-text-" + idx);
    if (textEl) {
        textEl.textContent = App.Minutes._transcripts[idx].original_text;
    }
};

App.Minutes._loadChatAndNotes = async function (meetingId, meeting) {
    try {
        var chatData = await App.api("/api/meetings/" + meetingId + "/chat");
        var chatMessages = chatData.messages || chatData;
        var content = document.getElementById("minutesDetailContent");
        if (!content) return;
        var extraHtml = "";

        // Notes section
        if (meeting.notes) {
            extraHtml += '<div class="minutes-notes-section">' +
                '<h3>Meeting Notes</h3>' +
                '<div class="minutes-notes-content">' + App.Utils.escapeHtml(meeting.notes) + '</div>' +
                '</div>';
        }

        // Chat section
        if (chatMessages && chatMessages.length > 0) {
            extraHtml += '<div class="minutes-chat-section">' +
                '<h3>Meeting Chat</h3><div class="minutes-chat-list">';
            chatMessages.forEach(function (msg) {
                extraHtml += '<div class="minutes-chat-msg">' +
                    '<span class="minutes-chat-name">' + App.Utils.escapeHtml(msg.user_name) + '</span>' +
                    '<span class="minutes-chat-time">' + App.Utils.formatTime(msg.created_at) + '</span>' +
                    '<div class="minutes-chat-text">' + App.Utils.escapeHtml(msg.message) + '</div>' +
                    '</div>';
            });
            extraHtml += '</div></div>';
        }

        if (extraHtml) {
            // Insert before the recording section
            var recordingSection = document.getElementById("minutesRecordingSection");
            if (recordingSection) {
                recordingSection.insertAdjacentHTML("beforebegin", extraHtml);
            } else {
                content.insertAdjacentHTML("beforeend", extraHtml);
            }
        }
    } catch (e) {
        // Chat/notes not available
    }
};

/* ─── Notifications Module ──────────────────────────────────────────────── */

App.Notifications = {};
App.Notifications._interval = null;
App.Notifications._open = false;

App.Notifications.init = function () {
    App.Notifications.destroy();
    App.Notifications.load();
    App.Notifications._interval = setInterval(App.Notifications.load, 30000);
};

App.Notifications.destroy = function () {
    if (App.Notifications._interval) {
        clearInterval(App.Notifications._interval);
        App.Notifications._interval = null;
    }
    App.Notifications._open = false;
    var panel = document.getElementById("notificationPanel");
    if (panel) panel.style.display = "none";
};

App.Notifications.load = async function () {
    try {
        var data = await App.api("/api/notifications");
        var badge = document.getElementById("notificationBadge");
        if (badge) {
            if (data.unread_count > 0) {
                badge.textContent = data.unread_count > 99 ? "99+" : data.unread_count;
                badge.style.display = "";
            } else {
                badge.style.display = "none";
            }
        }
        App.Notifications._data = data.notifications || [];
        if (App.Notifications._open) {
            App.Notifications.render();
        }
    } catch (e) {
        // Not logged in or error
    }
};

App.Notifications.toggle = function () {
    var panel = document.getElementById("notificationPanel");
    if (!panel) return;
    App.Notifications._open = !App.Notifications._open;
    panel.style.display = App.Notifications._open ? "block" : "none";
    if (App.Notifications._open) {
        App.Notifications.render();
    }
};

App.Notifications.render = function () {
    var list = document.getElementById("notificationList");
    if (!list) return;
    var notifications = App.Notifications._data || [];
    // Only show unread notifications
    var unread = notifications.filter(function (n) { return !n.is_read; });
    if (unread.length === 0) {
        list.innerHTML = '<div class="empty-state" style="padding:24px;"><p>No notifications</p></div>';
        return;
    }
    var html = "";
    unread.forEach(function (n) {
        var icon = n.type === "invitation" ? "&#x1F4E9;" :
                   n.type === "summary_ready" ? "&#x1F4CB;" :
                   n.type === "action_item_assigned" ? "&#x1F4CB;" :
                   n.type === "action_item_completed" ? "&#x2705;" : "&#x1F514;";
        var timeAgo = App.Notifications._relativeTime(n.created_at);
        html += '<div class="notification-item unread" onclick="App.Notifications.handleClick(' + n.id + ', \'' + (n.meeting_id || "") + '\')">' +
            '<div class="notification-item-icon">' + icon + '</div>' +
            '<div class="notification-item-content">' +
            '<div class="notification-item-title">' + App.Utils.escapeHtml(n.title) + '</div>' +
            '<div class="notification-item-message">' + App.Utils.escapeHtml(n.message) + '</div>' +
            '<div class="notification-item-time">' + timeAgo + '</div>' +
            '</div>' +
            '<div class="notification-unread-dot"></div>' +
            '</div>';
    });
    list.innerHTML = html;
};

App.Notifications._relativeTime = function (dateStr) {
    if (!dateStr) return "";
    var now = Date.now();
    var then = new Date(dateStr + "Z").getTime();
    var diff = Math.floor((now - then) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
};

App.Notifications.handleClick = async function (notificationId, meetingId) {
    try {
        await App.api("/api/notifications/" + notificationId + "/read", { method: "POST" });
    } catch (e) {}
    App.Notifications._open = false;
    document.getElementById("notificationPanel").style.display = "none";
    App.Notifications.load();
    if (meetingId) {
        App.navigate("minutes");
        setTimeout(function () { App.Minutes.loadDetail(meetingId); }, 100);
    }
};

App.Notifications.markAllRead = async function () {
    try {
        await App.api("/api/notifications/read-all", { method: "POST" });
        App.Notifications.load();
        App.Utils.toast("All notifications marked as read", "success");
    } catch (e) {}
};

/* ─── Search Module ─────────────────────────────────────────────────────── */

App.Search = {};

App.Search.init = function () {
    // Focus search input
    var input = document.getElementById("searchInput");
    if (input) setTimeout(function () { input.focus(); }, 100);
};

App.Search.execute = async function () {
    var q = document.getElementById("searchInput").value.trim();
    if (!q) { App.Utils.toast("Enter a search term", "error"); return; }

    var params = new URLSearchParams({ q: q });
    var fromDate = document.getElementById("searchFromDate").value;
    var toDate = document.getElementById("searchToDate").value;
    var language = document.getElementById("searchLanguage").value;
    if (fromDate) params.set("from_date", fromDate);
    if (toDate) params.set("to_date", toDate);
    if (language) params.set("language", language);

    var results = document.getElementById("searchResults");
    results.innerHTML = '<div class="empty-state"><div class="waiting-spinner"></div><p>Searching...</p></div>';

    try {
        var data = await App.api("/api/search?" + params.toString());
        App.Search.renderResults(data, q);
    } catch (err) {
        results.innerHTML = '<div class="empty-state"><p>Search failed: ' + App.Utils.escapeHtml(err.message) + '</p></div>';
    }
};

App.Search.renderResults = function (results, query) {
    var container = document.getElementById("searchResults");
    if (!results || results.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x1F50D;</div><h3>No results found</h3><p>Try different keywords or adjust your filters</p></div>';
        return;
    }

    var html = '<div style="margin-bottom:12px;color:var(--text-secondary);font-size:13px;">' + results.length + ' meeting(s) found</div>';
    var queryLower = query.toLowerCase();

    results.forEach(function (r) {
        html += '<div class="search-result-card" onclick="App.Minutes.loadDetail(\'' + r.meeting_id + '\')">' +
            '<div class="search-result-header">' +
            '<span class="search-result-name">' + App.Search._highlight(r.meeting_name, queryLower) + '</span>' +
            '<span class="meeting-card-status status-' + r.status + '">' + r.status + '</span>' +
            '</div>' +
            '<div class="search-result-meta">' +
            App.Utils.formatDateTime(r.ended_at || r.started_at || r.created_at) +
            (r.code ? ' &middot; ' + r.code : '') +
            '</div>';

        if (r.summary && r.summary.toLowerCase().indexOf(queryLower) >= 0) {
            var snippet = App.Search._getSnippet(r.summary, queryLower);
            html += '<div class="search-result-snippet">' + App.Search._highlight(snippet, queryLower) + '</div>';
        }

        if (r.matching_transcripts && r.matching_transcripts.length > 0) {
            html += '<div class="search-result-transcripts">';
            r.matching_transcripts.slice(0, 3).forEach(function (t) {
                html += '<div class="search-result-transcript">' +
                    '<span class="search-result-speaker">' + App.Utils.escapeHtml(t.speaker_name) + ':</span> ' +
                    App.Search._highlight(App.Search._getSnippet(t.original_text, queryLower), queryLower) +
                    '</div>';
            });
            if (r.matching_transcripts.length > 3) {
                html += '<div style="font-size:11px;color:var(--text-muted);">+' + (r.matching_transcripts.length - 3) + ' more matches</div>';
            }
            html += '</div>';
        }
        html += '</div>';
    });

    container.innerHTML = html;
};

App.Search._highlight = function (text, query) {
    if (!text || !query) return App.Utils.escapeHtml(text || "");
    var escaped = App.Utils.escapeHtml(text);
    var regex = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    return escaped.replace(regex, "<mark>$1</mark>");
};

App.Search._getSnippet = function (text, query) {
    if (!text) return "";
    var idx = text.toLowerCase().indexOf(query);
    if (idx < 0) return text.substring(0, 150);
    var start = Math.max(0, idx - 60);
    var end = Math.min(text.length, idx + query.length + 60);
    return (start > 0 ? "..." : "") + text.substring(start, end) + (end < text.length ? "..." : "");
};

/* ─── Export Module ─────────────────────────────────────────────────────── */

App.Export = {};

App.Export._getMeetingData = function () {
    var m = App.Minutes._currentMeeting;
    var t = App.Minutes._transcripts;
    if (!m) { App.Utils.toast("No meeting data loaded", "error"); return null; }
    return { meeting: m, transcripts: t };
};

App.Export.asMarkdown = function () {
    var data = App.Export._getMeetingData();
    if (!data) return;
    var m = data.meeting;
    var t = data.transcripts;

    var md = "# " + m.name + "\n\n";
    md += "**Date:** " + App.Utils.formatDateTime(m.ended_at || m.created_at) + "\n";
    md += "**Code:** " + (m.code || "N/A") + "\n";
    if (m.participants) {
        md += "**Participants:** " + m.participants.map(function (p) { return p.name; }).join(", ") + "\n";
    }
    md += "\n---\n\n## Summary\n\n" + (m.summary || "No summary available.") + "\n";

    if (m.notes) {
        md += "\n---\n\n## Meeting Notes\n\n" + m.notes + "\n";
    }

    if (t && t.length > 0) {
        md += "\n---\n\n## Transcript\n\n";
        t.forEach(function (entry) {
            md += "**" + entry.speaker_name + "** (" + App.Utils.formatTime(entry.timestamp) + "):\n";
            md += entry.original_text + "\n\n";
        });
    }

    App.Export._downloadFile(m.name.replace(/[^a-zA-Z0-9]/g, "_") + ".md", md, "text/markdown");
};

App.Export.asWord = function () {
    var data = App.Export._getMeetingData();
    if (!data) return;
    var m = data.meeting;
    var t = data.transcripts;

    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
        '<head><meta charset="utf-8"><style>' +
        'body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #333; margin: 40px; }' +
        'h1 { color: #1a56db; font-size: 20pt; border-bottom: 2px solid #1a56db; padding-bottom: 8px; }' +
        'h2 { color: #1a56db; font-size: 14pt; margin-top: 24px; }' +
        '.meta { color: #666; font-size: 10pt; margin-bottom: 16px; }' +
        '.transcript-entry { margin-bottom: 12px; }' +
        '.speaker { font-weight: bold; color: #1a56db; }' +
        '.time { color: #999; font-size: 9pt; }' +
        'hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }' +
        '</style></head><body>';

    html += '<h1>' + App.Utils.escapeHtml(m.name) + '</h1>';
    html += '<div class="meta">Date: ' + App.Utils.formatDateTime(m.ended_at || m.created_at) + ' | Code: ' + (m.code || "N/A") + '</div>';
    if (m.participants) {
        html += '<div class="meta">Participants: ' + m.participants.map(function (p) { return App.Utils.escapeHtml(p.name); }).join(", ") + '</div>';
    }
    html += '<hr><h2>Summary</h2><div>' + App.Utils.escapeHtml(m.summary || "No summary available.").replace(/\n/g, "<br>") + '</div>';

    if (m.notes) {
        html += '<hr><h2>Meeting Notes</h2><div>' + App.Utils.escapeHtml(m.notes).replace(/\n/g, "<br>") + '</div>';
    }

    if (t && t.length > 0) {
        html += '<hr><h2>Transcript</h2>';
        t.forEach(function (entry) {
            html += '<div class="transcript-entry"><span class="speaker">' + App.Utils.escapeHtml(entry.speaker_name) + '</span> <span class="time">(' + App.Utils.formatTime(entry.timestamp) + ')</span><br>' +
                App.Utils.escapeHtml(entry.original_text) + '</div>';
        });
    }
    html += '</body></html>';

    var blob = new Blob([html], { type: "application/msword" });
    App.Export._downloadBlob(m.name.replace(/[^a-zA-Z0-9]/g, "_") + ".doc", blob);
};

App.Export.asPDF = function () {
    var data = App.Export._getMeetingData();
    if (!data) return;
    var m = data.meeting;
    var t = data.transcripts;

    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + App.Utils.escapeHtml(m.name) + '</title>' +
        '<style>' +
        '@page { margin: 20mm; } ' +
        'body { font-family: "Segoe UI", Arial, sans-serif; font-size: 11pt; color: #222; margin: 0; padding: 20px; }' +
        '.header { text-align: center; border-bottom: 3px solid #1a56db; padding-bottom: 16px; margin-bottom: 24px; }' +
        '.header h1 { color: #1a56db; font-size: 22pt; margin: 0 0 4px 0; }' +
        '.header .company { font-size: 10pt; color: #888; letter-spacing: 2px; text-transform: uppercase; }' +
        '.meta { color: #666; font-size: 10pt; margin-bottom: 20px; }' +
        'h2 { color: #1a56db; font-size: 14pt; margin-top: 24px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }' +
        '.transcript-entry { margin-bottom: 10px; page-break-inside: avoid; }' +
        '.speaker { font-weight: bold; color: #1a56db; }' +
        '.time { color: #999; font-size: 9pt; }' +
        '.summary { white-space: pre-wrap; line-height: 1.7; }' +
        '@media print { body { padding: 0; } }' +
        '</style></head><body>';

    html += '<div class="header"><div class="company">MM Zettai Meeting System</div><h1>' + App.Utils.escapeHtml(m.name) + '</h1></div>';
    html += '<div class="meta">Date: ' + App.Utils.formatDateTime(m.ended_at || m.created_at) + ' &nbsp;|&nbsp; Code: ' + (m.code || "N/A") + '</div>';
    if (m.participants) {
        html += '<div class="meta">Participants: ' + m.participants.map(function (p) { return App.Utils.escapeHtml(p.name); }).join(", ") + '</div>';
    }
    html += '<h2>Summary</h2><div class="summary">' + App.Utils.escapeHtml(m.summary || "No summary available.") + '</div>';

    if (m.notes) {
        html += '<h2>Meeting Notes</h2><div class="summary">' + App.Utils.escapeHtml(m.notes) + '</div>';
    }

    if (t && t.length > 0) {
        html += '<h2>Transcript</h2>';
        t.forEach(function (entry) {
            html += '<div class="transcript-entry"><span class="speaker">' + App.Utils.escapeHtml(entry.speaker_name) + '</span> <span class="time">(' + App.Utils.formatTime(entry.timestamp) + ')</span><br>' +
                App.Utils.escapeHtml(entry.original_text) + '</div>';
        });
    }
    html += '</body></html>';

    var w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
    setTimeout(function () { w.print(); }, 500);
};

App.Export._downloadFile = function (filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType || "text/plain" });
    App.Export._downloadBlob(filename, blob);
};

App.Export._downloadBlob = function (filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
};

/* ─── Meeting Room: Chat, Reactions, Notes ──────────────────────────────── */

App.Meeting._chatUnreadCount = 0;
App.Meeting._activeSidebarTab = "participants";
App.Meeting._notesDebounceTimer = null;

App.Meeting.switchSidebarTab = function (tab) {
    App.Meeting._activeSidebarTab = tab;
    document.querySelectorAll(".sidebar-tab").forEach(function (el) {
        el.classList.toggle("active", el.dataset.tab === tab);
    });
    document.querySelectorAll(".sidebar-tab-content").forEach(function (el) {
        el.classList.remove("active");
    });
    var target = document.getElementById("tab-" + tab);
    if (target) target.classList.add("active");

    if (tab === "chat") {
        App.Meeting._chatUnreadCount = 0;
        var badge = document.getElementById("chatUnreadBadge");
        if (badge) badge.style.display = "none";
        var msgs = document.getElementById("chatMessages");
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
    if (tab === "tasks") {
        App.Meeting._actionItemCount = 0;
        var aiBadge = document.getElementById("actionItemsBadge");
        if (aiBadge) aiBadge.style.display = "none";
    }
};

App.Meeting.sendChat = function () {
    var input = document.getElementById("chatInput");
    if (!input) return;
    var msg = input.value.trim();
    if (!msg) return;
    if (App.Meeting._ws && App.Meeting._ws.readyState === WebSocket.OPEN) {
        App.Meeting._ws.send(JSON.stringify({ type: "chat", message: msg }));
        input.value = "";
    }
};

App.Meeting.sendReaction = function (reactionType) {
    if (App.Meeting._ws && App.Meeting._ws.readyState === WebSocket.OPEN) {
        App.Meeting._ws.send(JSON.stringify({ type: "reaction", reaction: reactionType }));
    }
};

App.Meeting._handleNotesInput = function () {
    if (App.Meeting._notesDebounceTimer) clearTimeout(App.Meeting._notesDebounceTimer);
    App.Meeting._notesDebounceTimer = setTimeout(function () {
        var textarea = document.getElementById("meetingNotesTextarea");
        if (!textarea) return;
        if (App.Meeting._ws && App.Meeting._ws.readyState === WebSocket.OPEN) {
            App.Meeting._ws.send(JSON.stringify({ type: "note_update", content: textarea.value }));
        }
    }, 500);
};

App.Meeting._displayChatMessage = function (data) {
    var container = document.getElementById("chatMessages");
    if (!container) return;
    var isSelf = data.userId === (App.state.user && App.state.user.id);
    var el = document.createElement("div");
    el.className = "chat-message" + (isSelf ? " chat-self" : "");
    el.innerHTML =
        '<div class="chat-message-name">' + App.Utils.escapeHtml(data.userName) + '</div>' +
        '<div class="chat-message-text">' + App.Utils.escapeHtml(data.message) + '</div>' +
        '<div class="chat-message-time">' + App.Utils.formatTime(data.timestamp || new Date().toISOString()) + '</div>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;

    // Update unread badge if chat tab is not active
    if (App.Meeting._activeSidebarTab !== "chat" && !isSelf) {
        App.Meeting._chatUnreadCount++;
        var badge = document.getElementById("chatUnreadBadge");
        if (badge) {
            badge.textContent = App.Meeting._chatUnreadCount;
            badge.style.display = "";
        }
    }
};

App.Meeting._displayReaction = function (data) {
    var container = document.getElementById("floatingReactions");
    if (!container) return;
    var reactionMap = { hand: "\u270B", thumbsup: "\uD83D\uDC4D", clap: "\uD83D\uDC4F", heart: "\u2764\uFE0F", laugh: "\uD83D\uDE02" };
    var emoji = reactionMap[data.reaction] || data.reaction;
    var el = document.createElement("div");
    el.className = "floating-reaction";
    el.textContent = emoji;
    el.style.left = (20 + Math.random() * 60) + "%";
    container.appendChild(el);
    setTimeout(function () { el.remove(); }, 3000);
};

// Patch the existing _handleWSMessage to handle new message types
(function () {
    var origHandler = App.Meeting._handleWSMessage;
    App.Meeting._handleWSMessage = function (data) {
        switch (data.type) {
            case "chat":
                App.Meeting._displayChatMessage(data);
                return;
            case "reaction":
                App.Meeting._displayReaction(data);
                return;
            case "note_update":
                var textarea = document.getElementById("meetingNotesTextarea");
                if (textarea && data.userId !== (App.state.user && App.state.user.id)) {
                    textarea.value = data.content;
                }
                return;
            case "action_item_created":
                if (data.item) {
                    App.Meeting._actionItems.push(data.item);
                    App.Meeting._renderActionItem(data.item);
                    App.Meeting._actionItemCount++;
                    var badge = document.getElementById("actionItemsBadge");
                    if (badge && App.Meeting._activeSidebarTab !== "tasks") {
                        badge.textContent = App.Meeting._actionItemCount;
                        badge.style.display = "";
                    }
                    App.Utils.toast("New task: " + (data.item.description || "").substring(0, 60), "info");
                }
                return;
            case "transcript_history":
                if (data.transcripts && data.transcripts.length > 0) {
                    data.transcripts.forEach(function (t) {
                        App.Meeting._displayTranscript(t);
                    });
                }
                return;
            case "action_item_updated":
                if (data.item) {
                    App.Meeting._updateActionItemInList(data.item);
                }
                return;
            case "host_joined":
            case "approved":
                // Set notes from server state
                origHandler.call(this, data);
                if (data.notes !== undefined) {
                    var ta = document.getElementById("meetingNotesTextarea");
                    if (ta) ta.value = data.notes || "";
                }
                // Populate assignee dropdown after participants are set
                setTimeout(App.Meeting._populateAssigneeDropdown, 100);
                return;
            default:
                origHandler.call(this, data);
        }
    };
})();

// Attach notes input listener after entering room
(function () {
    var origEnterRoom = App.Meeting.enterRoom;
    App.Meeting.enterRoom = function (meetingId, language) {
        origEnterRoom.call(this, meetingId, language);
        // Reset chat and notes state
        App.Meeting._chatUnreadCount = 0;
        App.Meeting._activeSidebarTab = "participants";
        App.Meeting._actionItems = [];
        App.Meeting._actionItemCount = 0;
        var chatMsgs = document.getElementById("chatMessages");
        if (chatMsgs) chatMsgs.innerHTML = "";
        var notesArea = document.getElementById("meetingNotesTextarea");
        if (notesArea) {
            notesArea.value = "";
            notesArea.oninput = App.Meeting._handleNotesInput;
        }
        var actionItemsList = document.getElementById("meetingActionItemsList");
        if (actionItemsList) actionItemsList.innerHTML = "";
        // Reset sidebar tabs
        document.querySelectorAll(".sidebar-tab").forEach(function (el) {
            el.classList.toggle("active", el.dataset.tab === "participants");
        });
        document.querySelectorAll(".sidebar-tab-content").forEach(function (el) {
            el.classList.toggle("active", el.id === "tab-participants");
        });
        var badge = document.getElementById("chatUnreadBadge");
        if (badge) badge.style.display = "none";
        var aiBadge = document.getElementById("actionItemsBadge");
        if (aiBadge) aiBadge.style.display = "none";
    };
})();

/* ─── Action Items in Meeting Room ──────────────────────────────────────── */

App.Meeting._actionItems = [];
App.Meeting._actionItemCount = 0;

App.Meeting.addActionItem = function () {
    var assigneeSelect = document.getElementById("actionItemAssignee");
    var descInput = document.getElementById("actionItemDescription");
    if (!assigneeSelect || !descInput) return;
    var assignedTo = parseInt(assigneeSelect.value);
    var description = descInput.value.trim();
    if (!assignedTo) { App.Utils.toast("Select an assignee", "error"); return; }
    if (!description) { App.Utils.toast("Enter a task description", "error"); return; }
    if (App.Meeting._ws && App.Meeting._ws.readyState === WebSocket.OPEN) {
        App.Meeting._ws.send(JSON.stringify({
            type: "add_action_item",
            assignedTo: assignedTo,
            description: description
        }));
        descInput.value = "";
    }
};

App.Meeting._populateAssigneeDropdown = function () {
    var select = document.getElementById("actionItemAssignee");
    if (!select) return;
    var html = '<option value="">Assign to...</option>';
    for (var uid in App.Meeting._participants) {
        var p = App.Meeting._participants[uid];
        html += '<option value="' + uid + '">' + App.Utils.escapeHtml(p.name) + '</option>';
    }
    select.innerHTML = html;
};

App.Meeting._renderActionItem = function (item) {
    var list = document.getElementById("meetingActionItemsList");
    if (!list) return;
    var el = document.createElement("div");
    el.className = "action-item-card";
    el.id = "action-item-" + item.id;
    var statusClass = "status-" + (item.status || "pending");
    el.innerHTML =
        '<div class="action-item-card-header">' +
        '<span class="action-item-status ' + statusClass + '">' + App.Utils.escapeHtml(item.status || "pending") + '</span>' +
        '</div>' +
        '<div class="action-item-description">' + App.Utils.escapeHtml(item.description) + '</div>' +
        '<div class="action-item-meta">' +
        '<span>To: ' + App.Utils.escapeHtml(item.assigned_to_name || "Unknown") + '</span>' +
        '<span>By: ' + App.Utils.escapeHtml(item.created_by_name || "Unknown") + '</span>' +
        '</div>';
    list.appendChild(el);
};

App.Meeting._updateActionItemInList = function (item) {
    var el = document.getElementById("action-item-" + item.id);
    if (!el) {
        App.Meeting._renderActionItem(item);
        return;
    }
    var statusClass = "status-" + (item.status || "pending");
    var statusEl = el.querySelector(".action-item-status");
    if (statusEl) {
        statusEl.className = "action-item-status " + statusClass;
        statusEl.textContent = item.status || "pending";
    }
    var descEl = el.querySelector(".action-item-description");
    if (descEl) descEl.textContent = item.description;
};

/* ─── My Action Items Page ─────────────────────────────────────────────── */

App.MyTasks = {};

App.MyTasks.load = async function () {
    var container = document.getElementById("myActionItemsList");
    if (!container) return;
    container.innerHTML = '<div class="empty-state"><div class="waiting-spinner"></div><p>Loading action items...</p></div>';
    try {
        var items = await App.api("/api/my-action-items");
        if (!items || items.length === 0) {
            container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#x1F4CB;</div><h3>No action items</h3><p>Tasks assigned to you will appear here</p></div>';
            return;
        }
        var html = '';
        items.forEach(function (item) {
            var statusClass = "status-" + (item.status || "pending");
            var actions = '';
            if (item.status === "pending") {
                actions = '<div class="my-action-item-actions">' +
                    '<button class="btn btn-primary btn-sm" onclick="App.MyTasks.updateStatus(' + item.id + ', \'accepted\')">Accept</button>' +
                    '<button class="btn btn-danger btn-sm" onclick="App.MyTasks.updateStatus(' + item.id + ', \'declined\')">Decline</button>' +
                    '</div>';
            } else if (item.status === "accepted") {
                actions = '<div class="my-action-item-actions">' +
                    '<button class="btn btn-success btn-sm" onclick="App.MyTasks.updateStatus(' + item.id + ', \'completed\')">Mark Done</button>' +
                    '</div>';
            }
            html += '<div class="my-action-item-card" id="my-task-' + item.id + '">' +
                '<div class="my-action-item-header">' +
                '<span class="my-action-item-meeting" onclick="App.Minutes.loadDetail(\'' + item.meeting_id + '\')">' + App.Utils.escapeHtml(item.meeting_name || "Meeting") + '</span>' +
                '<span class="action-item-status ' + statusClass + '">' + App.Utils.escapeHtml(item.status || "pending") + '</span>' +
                '</div>' +
                '<div class="my-action-item-desc">' + App.Utils.escapeHtml(item.description) + '</div>' +
                '<div class="my-action-item-meta">' +
                '<span>Assigned by: ' + App.Utils.escapeHtml(item.created_by_name || "Unknown") + '</span>' +
                '<span>' + App.Utils.formatDateTime(item.created_at) + '</span>' +
                (item.completed_at ? '<span>Completed: ' + App.Utils.formatDateTime(item.completed_at) + '</span>' : '') +
                '</div>' +
                actions +
                '</div>';
        });
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = '<div class="empty-state"><h3>Failed to load action items</h3><p>' + App.Utils.escapeHtml(err.message) + '</p></div>';
    }
};

App.MyTasks.updateStatus = async function (itemId, status) {
    try {
        await App.api("/api/action-items/" + itemId, {
            method: "PUT",
            json: { status: status }
        });
        App.Utils.toast("Action item " + status, "success");
        App.MyTasks.load();
    } catch (err) {
        App.Utils.toast("Failed to update: " + err.message, "error");
    }
};

/* ─── Action Items in Minutes Detail ───────────────────────────────────── */

App.Minutes._loadActionItems = async function (meetingId) {
    try {
        var items = await App.api("/api/meetings/" + meetingId + "/action-items");
        if (!items || items.length === 0) return;
        var content = document.getElementById("minutesDetailContent");
        if (!content) return;

        var userId = App.state.user ? App.state.user.id : null;
        var html = '<div class="minutes-action-items-section">' +
            '<h3>Action Items (' + items.length + ')</h3>';

        items.forEach(function (item) {
            var statusClass = "status-" + (item.status || "pending");
            var isAssignee = userId === item.assigned_to;
            var isCreator = userId === item.created_by;

            var actions = '';
            if (isAssignee && item.status === "pending") {
                actions = '<div class="action-item-actions">' +
                    '<button class="btn btn-primary btn-sm" onclick="App.Minutes.updateActionItem(' + item.id + ', \'accepted\')">Accept</button>' +
                    '<button class="btn btn-danger btn-sm" onclick="App.Minutes.updateActionItem(' + item.id + ', \'declined\')">Decline</button>' +
                    '</div>';
            } else if (isAssignee && item.status === "accepted") {
                actions = '<div class="action-item-actions">' +
                    '<button class="btn btn-success btn-sm" onclick="App.Minutes.updateActionItem(' + item.id + ', \'completed\')">Mark Done</button>' +
                    '</div>';
            }

            html += '<div class="minutes-action-item" id="minutes-ai-' + item.id + '">' +
                '<div class="minutes-action-item-content">' +
                '<div class="minutes-action-item-desc">' + App.Utils.escapeHtml(item.description) + '</div>' +
                '<div class="minutes-action-item-people">' +
                'Assigned to: <span>' + App.Utils.escapeHtml(item.assigned_to_name) + '</span>' +
                ' &middot; By: <span>' + App.Utils.escapeHtml(item.created_by_name) + '</span>' +
                '</div>' +
                '</div>' +
                '<div class="minutes-action-item-right">' +
                '<span class="action-item-status ' + statusClass + '">' + App.Utils.escapeHtml(item.status || "pending") + '</span>' +
                actions +
                '</div>' +
                '</div>';
        });
        html += '</div>';

        // Insert after summary section
        var summaryEl = content.querySelector(".minutes-summary");
        if (summaryEl) {
            summaryEl.insertAdjacentHTML("afterend", html);
        } else {
            content.insertAdjacentHTML("afterbegin", html);
        }
    } catch (e) {
        // Action items not available
    }
};

App.Minutes.updateActionItem = async function (itemId, status) {
    try {
        var updated = await App.api("/api/action-items/" + itemId, {
            method: "PUT",
            json: { status: status }
        });
        App.Utils.toast("Action item " + status, "success");
        // Update in place
        var el = document.getElementById("minutes-ai-" + itemId);
        if (el && updated) {
            var statusEl = el.querySelector(".action-item-status");
            if (statusEl) {
                statusEl.className = "action-item-status status-" + updated.status;
                statusEl.textContent = updated.status;
            }
            var actionsEl = el.querySelector(".action-item-actions");
            if (actionsEl) {
                if (updated.status === "accepted") {
                    actionsEl.innerHTML = '<button class="btn btn-success btn-sm" onclick="App.Minutes.updateActionItem(' + itemId + ', \'completed\')">Mark Done</button>';
                } else {
                    actionsEl.remove();
                }
            }
        }
    } catch (err) {
        App.Utils.toast("Failed to update: " + err.message, "error");
    }
};

/* ─── Boot ───────────────────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", App.init);
