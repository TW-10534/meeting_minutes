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
    if (page === "minutes") App.Minutes.loadList();
    if (page === "settings") App.Settings.load();
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
        if (App.Dashboard._meetingDates[dateStr]) classes += " has-meeting";
        html += '<div class="' + classes + '" data-date="' + dateStr + '">' + d + "</div>";
    }

    // Next month days
    var remaining = 42 - (startOffset + totalDays);
    for (var d = 1; d <= remaining; d++) {
        html += '<div class="calendar-day other-month">' + d + "</div>";
    }

    grid.innerHTML = html;
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
        document.getElementById("scheduleInviteLinkBox").classList.add("visible");
        document.getElementById("scheduleInviteCodeInput").value = meeting.code;
        await App.fetchTunnelUrl();
        document.getElementById("scheduleInviteLinkInput").value = App.getShareBaseUrl() + "/#/join/" + meeting.code;
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

    var translationHtml = "";
    if (data.translatedText) {
        translationHtml = '<div class="transcript-translation">' + App.Utils.escapeHtml(data.translatedText) + '</div>';
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
        '</div>' +
        '<div class="transcript-text">' + App.Utils.escapeHtml(data.displayText || data.originalText) + '</div>' +
        translationHtml +
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

/* ─── Minutes Module ─────────────────────────────────────────────────────── */

App.Minutes = {};

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

        var meeting = await App.api("/api/meetings/" + meetingId);
        var transcripts = await App.api("/api/meetings/" + meetingId + "/transcripts");

        // Show detail page
        document.querySelectorAll(".page-view").forEach(function (el) { el.classList.remove("active"); });
        document.getElementById("page-minutes-detail").classList.add("active");

        document.getElementById("minutesDetailTitle").textContent = meeting.name;
        document.getElementById("minutesDetailSubtitle").textContent =
            App.Utils.formatDateTime(meeting.ended_at || meeting.created_at) + " | " +
            (meeting.participants ? meeting.participants.length : 0) + " participants";

        var content = document.getElementById("minutesDetailContent");
        var html = "";

        // Summary section
        html += '<div class="minutes-summary">' +
            '<h3>AI-Generated Summary</h3>' +
            '<div class="minutes-summary-content">' +
            App.Utils.escapeHtml(meeting.summary || "No summary available.") +
            '</div></div>';

        // Transcript section
        if (transcripts.length > 0) {
            html += '<div class="minutes-transcript-section"><h3>Full Transcript</h3>';
            transcripts.forEach(function (t) {
                var avatarClass = App.Utils.getAvatarClass(t.speaker_id);
                var initial = (t.speaker_name || "?").charAt(0).toUpperCase();
                var langBadge = "lang-" + (t.original_language || "en");
                var langName = App.LANG_NAMES[t.original_language] || t.original_language;

                html += '<div class="transcript-message">' +
                    '<div class="transcript-avatar ' + avatarClass + '">' + initial + '</div>' +
                    '<div class="transcript-content">' +
                    '<div class="transcript-header">' +
                    '<span class="transcript-name">' + App.Utils.escapeHtml(t.speaker_name) + '</span>' +
                    '<span class="transcript-lang-badge ' + langBadge + '">' + langName + '</span>' +
                    '<span class="transcript-time">' + App.Utils.formatTime(t.timestamp) + '</span>' +
                    '</div>' +
                    '<div class="transcript-text">' + App.Utils.escapeHtml(t.original_text) + '</div>';

                if (t.translations) {
                    for (var lang in t.translations) {
                        html += '<div class="transcript-translation">[' +
                            (App.LANG_NAMES[lang] || lang) + '] ' +
                            App.Utils.escapeHtml(t.translations[lang]) + '</div>';
                    }
                }
                html += '</div></div>';
            });
            html += '</div>';
        }

        // Recording section
        try {
            var recordings = await App.api("/api/meetings/" + meetingId + "/recording");
            if (recordings.chunks && recordings.chunks.length > 0) {
                html += '<div class="minutes-recording-section"><h3>Meeting Recordings</h3>';
                recordings.chunks.forEach(function (chunk, i) {
                    html += '<div style="margin-bottom:8px;">' +
                        '<p style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Segment ' + (i + 1) + '</p>' +
                        '<audio controls class="audio-player" preload="none">' +
                        '<source src="/api/recordings/' + chunk + '" type="audio/webm">' +
                        'Your browser does not support the audio element.' +
                        '</audio></div>';
                });
                html += '</div>';
            }
        } catch (e) {
            // No recordings available
        }

        content.innerHTML = html;
        window.location.hash = "#/minutes/" + meetingId;
    } catch (err) {
        App.Utils.toast("Failed to load meeting details", "error");
    } finally {
        App.Utils.hideLoading();
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

/* ─── Boot ───────────────────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", App.init);
