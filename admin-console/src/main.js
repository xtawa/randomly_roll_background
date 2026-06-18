import "./styles.css";

const NAV_ITEMS = [
  { key: "home", label: "首页" },
  { key: "enroll", label: "录入人脸" },
  { key: "roster", label: "名册" },
  { key: "devices", label: "设备" },
  { key: "publish", label: "发布" },
  { key: "settings", label: "设置" }
];

const LOCAL_KEYS = {
  apiBaseUrl: "admin-console-api-base-url",
  token: "admin-console-token",
  email: "roll-console-email"
};

const app = document.getElementById("app");

const state = {
  activeView: "home",
  apiBaseUrl: normalizeApiBaseUrl(window.localStorage.getItem(LOCAL_KEYS.apiBaseUrl) || "https://roll.underflo.ink"),
  authToken: window.localStorage.getItem(LOCAL_KEYS.token) || "",
  sessionEmail: window.localStorage.getItem(LOCAL_KEYS.email) || "",
  status: {
    tone: "neutral",
    message: "准备就绪。可以先登录，再打开摄像头开始录入。"
  },
  loading: false,
  searchQuery: "",
  camera: {
    enabled: false,
    captures: []
  },
  draft: {
    personId: "",
    displayName: "",
    baseWeight: 1,
    tags: "",
    preferred: false,
    ignored: false,
    sampleNotes: "正脸 / 微侧脸 / 自然表情"
  },
  faces: [
    {
      personId: "stu-001",
      displayName: "张三",
      preferred: true,
      ignored: false,
      baseWeight: 2,
      tags: ["class-a"],
      descriptorCount: 4,
      sampleCount: 4,
      updatedAt: "2026-06-18 09:40:00"
    },
    {
      personId: "stu-002",
      displayName: "李四",
      preferred: false,
      ignored: false,
      baseWeight: 1,
      tags: ["class-a"],
      descriptorCount: 3,
      sampleCount: 3,
      updatedAt: "2026-06-18 09:52:00"
    }
  ],
  devices: [
    {
      deviceCode: "15e27ca2fd9f3b2f-demo",
      classroom: "Room 301",
      packageVersion: "2026.06.18.1",
      devModeEnabled: false,
      pairedAt: "2026-06-18 10:00:00",
      lastSeenAt: "2026-06-18 10:20:00"
    }
  ],
  packages: [
    {
      version: "2026.06.18.1",
      isActive: true,
      notes: "初始班级包",
      peopleCount: 2,
      publishedAt: "2026-06-18 10:10:00",
      operator: "admin@example.com"
    }
  ]
};

let liveStream = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeApiBaseUrl(value) {
  const rawValue = String(value || "").trim() || "https://roll.underflo.ink";
  const withProtocol = /^https?:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`;
  return withProtocol.replace(/\/+$/, "");
}

function setStatus(message, tone = "neutral") {
  state.status = { message, tone };
  render();
}

function setLoading(nextValue) {
  state.loading = nextValue;
  render();
}

function persistSession() {
  window.localStorage.setItem(LOCAL_KEYS.apiBaseUrl, state.apiBaseUrl);
  window.localStorage.setItem(LOCAL_KEYS.token, state.authToken);
  window.localStorage.setItem(LOCAL_KEYS.email, state.sessionEmail);
}

function isLoggedIn() {
  return Boolean(state.authToken);
}

function formatDate(value) {
  if (!value) {
    return "未同步";
  }

  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(value);
  }
}

function makePersonId(displayName) {
  const ascii = String(displayName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return ascii ? `person-${ascii}` : `person-${Date.now()}`;
}

function parseTags(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function clampDescriptorCount(value) {
  return Math.min(5, Math.max(1, Number(value) || 1));
}

function revokeCaptureUrls() {
  state.camera.captures.forEach((capture) => {
    URL.revokeObjectURL(capture.previewUrl);
  });
}

function stopCameraTracks() {
  if (!liveStream) {
    return;
  }

  liveStream.getTracks().forEach((track) => {
    track.stop();
  });
  liveStream = null;
}

async function requestApi(path, { method = "GET", body } = {}) {
  const headers = {};
  const isFormData = body instanceof FormData;

  if (state.authToken) {
    headers.Authorization = `Bearer ${state.authToken}`;
  }

  if (body && !isFormData) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${state.apiBaseUrl}${path}`, {
    method,
    headers,
    body: !body ? undefined : isFormData ? body : JSON.stringify(body)
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof payload === "string" ? payload : payload?.message || `${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function normalizeFaceRecord(item) {
  return {
    personId: item.personId,
    displayName: item.displayName,
    preferred: Boolean(item.preferred),
    ignored: Boolean(item.ignored),
    baseWeight: Number(item.baseWeight || 1),
    tags: Array.isArray(item.tags) ? item.tags : [],
    descriptorCount: Number(item.descriptorCount || item.descriptors || 0),
    sampleCount: Number(item.sampleCount || item.descriptorCount || 0),
    updatedAt: item.updatedAt || new Date().toISOString()
  };
}

function normalizeDeviceRecord(item) {
  return {
    deviceCode: item.deviceCode,
    classroom: item.classroom || "未命名教室",
    packageVersion: item.packageVersion || "未绑定",
    devModeEnabled: Boolean(item.devModeEnabled),
    pairedAt: item.pairedAt || new Date().toISOString(),
    lastSeenAt: item.lastSeenAt || null
  };
}

function normalizePackageRecord(item) {
  return {
    version: item.version,
    isActive: Boolean(item.isActive),
    notes: item.notes || "",
    peopleCount: Number(item.peopleCount || 0),
    publishedAt: item.publishedAt || new Date().toISOString(),
    operator: item.operator || state.sessionEmail || "operator@example.com"
  };
}

async function refreshFaces() {
  const payload = await requestApi("/api/admin/faces");
  state.faces = (payload.items || []).map(normalizeFaceRecord);
}

async function refreshDevices() {
  const payload = await requestApi("/api/admin/devices");
  state.devices = (payload.items || []).map(normalizeDeviceRecord);
}

async function refreshPackages() {
  const payload = await requestApi("/api/admin/packages");
  state.packages = (payload.items || []).map(normalizePackageRecord);
}

async function refreshAll({ silent = false } = {}) {
  if (!isLoggedIn()) {
    render();
    return;
  }

  if (!silent) {
    setLoading(true);
  }

  const results = await Promise.allSettled([refreshFaces(), refreshDevices(), refreshPackages()]);
  const hasSuccess = results.some((result) => result.status === "fulfilled");

  if (hasSuccess) {
    if (!silent) {
      state.status = {
        tone: "success",
        message: "已同步最新数据。"
      };
    }
  } else if (!silent) {
    state.status = {
      tone: "error",
      message: "服务器暂时不可用，当前显示的是本地预览数据。"
    };
  }

  state.loading = false;
  render();
}

function upsertLocalFace(record) {
  const nextRecord = normalizeFaceRecord(record);
  const existingIndex = state.faces.findIndex((item) => item.personId === nextRecord.personId);

  if (existingIndex >= 0) {
    state.faces.splice(existingIndex, 1, nextRecord);
  } else {
    state.faces.unshift(nextRecord);
  }
}

function upsertLocalDevice(record) {
  const nextRecord = normalizeDeviceRecord(record);
  const existingIndex = state.devices.findIndex((item) => item.deviceCode === nextRecord.deviceCode);

  if (existingIndex >= 0) {
    state.devices.splice(existingIndex, 1, nextRecord);
  } else {
    state.devices.unshift(nextRecord);
  }
}

function upsertLocalPackage(record) {
  const nextRecord = normalizePackageRecord(record);
  const existingIndex = state.packages.findIndex((item) => item.version === nextRecord.version);

  state.packages = state.packages.map((item) => ({
    ...item,
    isActive: item.version === nextRecord.version ? nextRecord.isActive : false
  }));

  if (existingIndex >= 0) {
    state.packages.splice(existingIndex, 1, nextRecord);
  } else {
    state.packages.unshift(nextRecord);
  }
}

async function login(email, password) {
  setLoading(true);

  try {
    const payload = await requestApi("/api/auth/login", {
      method: "POST",
      body: { email, password }
    });

    state.authToken = payload.token || "";
    state.sessionEmail = payload.user?.email || email;
    persistSession();
    state.status = {
      tone: "success",
      message: "登录成功，正在读取名册和设备信息。"
    };
    render();
    await refreshAll({ silent: false });
  } catch (error) {
    state.loading = false;
    setStatus(`登录失败：${error.message}`, "error");
  }
}

function logout() {
  state.authToken = "";
  state.sessionEmail = "";
  persistSession();
  setStatus("已退出当前账号。", "success");
}

function resetDraft() {
  revokeCaptureUrls();
  state.camera.captures = [];
  state.draft = {
    personId: "",
    displayName: "",
    baseWeight: 1,
    tags: "",
    preferred: false,
    ignored: false,
    sampleNotes: "正脸 / 微侧脸 / 自然表情"
  };
}

function openEnrollDraft(record = null) {
  revokeCaptureUrls();
  state.camera.captures = [];

  if (record) {
    state.draft = {
      personId: record.personId,
      displayName: record.displayName,
      baseWeight: record.baseWeight,
      tags: record.tags.join(", "),
      preferred: record.preferred,
      ignored: record.ignored,
      sampleNotes: "补充新样本"
    };
  } else {
    resetDraft();
  }

  state.activeView = "enroll";
  render();
}

function switchView(nextView) {
  if (state.activeView === "enroll" && nextView !== "enroll") {
    stopCameraTracks();
    state.camera.enabled = false;
  }

  state.activeView = nextView;
  render();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("当前浏览器不支持摄像头调用。", "error");
    return;
  }

  try {
    stopCameraTracks();
    liveStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    state.camera.enabled = true;
    render();
    attachCameraStream();
    setStatus("摄像头已开启，请让面部保持在取景框中央。", "success");
  } catch (error) {
    state.camera.enabled = false;
    setStatus(`无法打开摄像头：${error.message}`, "error");
  }
}

function stopCamera() {
  stopCameraTracks();
  state.camera.enabled = false;
  render();
  setStatus("摄像头已关闭。", "neutral");
}

function attachCameraStream() {
  const video = document.querySelector("[data-camera-preview]");
  if (!video || !liveStream) {
    return;
  }

  if (video.srcObject !== liveStream) {
    video.srcObject = liveStream;
  }

  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.play().catch(() => {});
}

async function captureFrame() {
  const video = document.querySelector("[data-camera-preview]");
  if (!video || !video.videoWidth || !video.videoHeight) {
    setStatus("画面尚未准备好，请稍后再试。", "error");
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");

  if (!context) {
    setStatus("当前浏览器无法创建采样画布。", "error");
    return;
  }

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.92);
  });

  if (!blob) {
    setStatus("当前帧采集失败，请重新尝试。", "error");
    return;
  }

  if (state.camera.captures.length >= 5) {
    const removed = state.camera.captures.shift();
    if (removed) {
      URL.revokeObjectURL(removed.previewUrl);
    }
  }

  const previewUrl = URL.createObjectURL(blob);
  const file = new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" });

  state.camera.captures.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    previewUrl
  });

  render();
  setStatus(`已采集 ${state.camera.captures.length} 张样本，建议完成 3 到 5 张。`, "success");
}

function removeCapture(captureId) {
  const capture = state.camera.captures.find((item) => item.id === captureId);
  if (capture) {
    URL.revokeObjectURL(capture.previewUrl);
  }

  state.camera.captures = state.camera.captures.filter((item) => item.id !== captureId);
  render();
}

function clearCaptures() {
  revokeCaptureUrls();
  state.camera.captures = [];
  render();
}

async function handleEnrollSubmit(event) {
  event.preventDefault();

  const formData = new FormData(event.currentTarget);
  const displayName = String(formData.get("displayName") || "").trim();
  const personId = String(formData.get("personId") || "").trim() || makePersonId(displayName);
  const baseWeight = Number(formData.get("baseWeight") || 1);
  const tags = parseTags(formData.get("tags"));
  const preferred = formData.get("preferred") === "on";
  const ignored = formData.get("ignored") === "on";
  const sampleNotes = String(formData.get("sampleNotes") || "").trim();
  const captureCount = state.camera.captures.length;
  const exists = state.faces.some((item) => item.personId === personId);

  if (!displayName) {
    setStatus("请填写姓名或显示名称。", "error");
    return;
  }

  if (captureCount < 3) {
    setStatus("请至少采集 3 张样本后再保存。", "error");
    return;
  }

  const profilePayload = {
    personId,
    displayName,
    baseWeight,
    tags,
    preferred,
    ignored
  };

  const uploadBody = new FormData();
  uploadBody.set("notes", sampleNotes);
  state.camera.captures.forEach((capture) => {
    uploadBody.append("files", capture.file, capture.file.name);
  });

  setLoading(true);

  try {
    if (!isLoggedIn()) {
      throw new Error("请先在设置页登录。");
    }

    await requestApi(exists ? `/api/admin/faces/${encodeURIComponent(personId)}` : "/api/admin/faces", {
      method: exists ? "PATCH" : "POST",
      body: profilePayload
    });

    await requestApi(`/api/admin/faces/${encodeURIComponent(personId)}/samples`, {
      method: "POST",
      body: uploadBody
    });

    upsertLocalFace({
      ...profilePayload,
      descriptorCount: clampDescriptorCount(captureCount),
      sampleCount: captureCount,
      updatedAt: new Date().toISOString()
    });

    stopCameraTracks();
    state.camera.enabled = false;
    revokeCaptureUrls();
    state.camera.captures = [];
    state.loading = false;
    state.activeView = "roster";
    state.status = {
      tone: "success",
      message: `${displayName} 已录入完成。`
    };
    render();
    await refreshFaces();
    render();
  } catch (error) {
    upsertLocalFace({
      ...profilePayload,
      descriptorCount: clampDescriptorCount(captureCount),
      sampleCount: captureCount,
      updatedAt: new Date().toISOString()
    });

    state.loading = false;
    setStatus(`服务器暂不可用，已保留本地预览：${error.message}`, "error");
  }
}

async function handleDeviceSubmit(event) {
  event.preventDefault();

  const formData = new FormData(event.currentTarget);
  const deviceCode = String(formData.get("deviceCode") || "").trim();
  const classroom = String(formData.get("classroom") || "").trim();
  const packageVersion = String(formData.get("packageVersion") || "").trim();
  const devModeEnabled = formData.get("devModeEnabled") === "on";

  if (!deviceCode || !classroom || !packageVersion) {
    setStatus("请填写完整的设备信息。", "error");
    return;
  }

  setLoading(true);

  try {
    const payload = await requestApi("/api/admin/devices/pair", {
      method: "POST",
      body: {
        deviceCode,
        classroom,
        packageVersion,
        devModeEnabled
      }
    });

    upsertLocalDevice(payload);
    state.loading = false;
    setStatus(`设备 ${deviceCode} 已绑定到 ${classroom}。`, "success");
    await refreshDevices();
    render();
  } catch (error) {
    upsertLocalDevice({
      deviceCode,
      classroom,
      packageVersion,
      devModeEnabled,
      pairedAt: new Date().toISOString()
    });

    state.loading = false;
    setStatus(`设备信息已写入本地预览：${error.message}`, "error");
  }
}

async function handlePublishSubmit(event) {
  event.preventDefault();

  const formData = new FormData(event.currentTarget);
  const version = String(formData.get("version") || "").trim() || suggestVersion();
  const notes = String(formData.get("notes") || "").trim();

  setLoading(true);

  try {
    const payload = await requestApi("/api/admin/packages/publish", {
      method: "POST",
      body: { version, notes }
    });

    upsertLocalPackage({
      version: payload.version,
      isActive: true,
      notes,
      peopleCount: payload.peopleCount || state.faces.length,
      publishedAt: payload.publishedAt || new Date().toISOString(),
      operator: state.sessionEmail || "operator@example.com"
    });

    state.loading = false;
    setStatus(`已发布版本 ${version}。`, "success");
    await refreshPackages();
    render();
  } catch (error) {
    upsertLocalPackage({
      version,
      isActive: true,
      notes,
      peopleCount: state.faces.length,
      publishedAt: new Date().toISOString(),
      operator: state.sessionEmail || "operator@example.com"
    });

    state.loading = false;
    setStatus(`发布结果已保留在本地预览：${error.message}`, "error");
  }
}

async function handleRollbackSubmit(event) {
  event.preventDefault();

  const formData = new FormData(event.currentTarget);
  const rollbackVersion = String(formData.get("rollbackVersion") || "").trim();

  if (!rollbackVersion) {
    setStatus("请选择要恢复的版本。", "error");
    return;
  }

  setLoading(true);

  try {
    await requestApi(`/api/admin/packages/${encodeURIComponent(rollbackVersion)}/rollback`, {
      method: "POST",
      body: {}
    });

    upsertLocalPackage({
      ...(state.packages.find((item) => item.version === rollbackVersion) || {}),
      version: rollbackVersion,
      isActive: true
    });

    state.loading = false;
    setStatus(`已恢复到版本 ${rollbackVersion}。`, "success");
    await refreshPackages();
    render();
  } catch (error) {
    upsertLocalPackage({
      ...(state.packages.find((item) => item.version === rollbackVersion) || {}),
      version: rollbackVersion,
      isActive: true,
      notes: "本地恢复预览"
    });

    state.loading = false;
    setStatus(`恢复结果已保留在本地预览：${error.message}`, "error");
  }
}

function suggestVersion() {
  const stamp = new Date();
  const datePart = `${stamp.getFullYear()}.${String(stamp.getMonth() + 1).padStart(2, "0")}.${String(stamp.getDate()).padStart(2, "0")}`;
  const sequence = state.packages.filter((item) => String(item.version || "").startsWith(datePart)).length + 1;
  return `${datePart}.${sequence}`;
}

function filteredFaces() {
  const query = state.searchQuery.trim().toLowerCase();
  if (!query) {
    return state.faces;
  }

  return state.faces.filter((item) => {
    return [
      item.personId,
      item.displayName,
      item.tags.join(" ")
    ].some((value) => String(value).toLowerCase().includes(query));
  });
}

function renderTopbar() {
  return `
    <header class="hero-shell">
      <div class="hero-card">
        <div class="hero-copy">
          <span class="eyebrow">Smart Roll Call</span>
          <h1>把录入、配对和发布，做成老师也能直接用的流程。</h1>
          <p>先登录，再打开摄像头采集 3 到 5 张人脸样本，保存到名册后即可发布到教室设备。</p>
          <div class="hero-actions">
            <button class="primary-button" type="button" data-quick-view="enroll">开始录入</button>
            <button class="ghost-button" type="button" data-quick-view="roster">查看名册</button>
          </div>
        </div>
        <div class="hero-side">
          <div class="session-badge">${isLoggedIn() ? `已登录：${escapeHtml(state.sessionEmail || "当前账号")}` : "尚未登录"}</div>
          <div class="status ${state.status.tone}">${escapeHtml(state.status.message)}</div>
        </div>
      </div>
    </header>
  `;
}

function renderNav() {
  return `
    <aside class="sidebar">
      <div class="nav-title">功能</div>
      <div class="nav-list">
        ${NAV_ITEMS.map((item) => `
          <button class="nav-button ${state.activeView === item.key ? "active" : ""}" data-nav-view="${item.key}" type="button">
            ${item.label}
          </button>
        `).join("")}
      </div>
    </aside>
  `;
}

function renderHome() {
  const latestPackage = state.packages[0];
  const latestDevice = state.devices[0];
  const recentFaces = state.faces.slice(0, 3);

  return `
    <section class="panel">
      <div class="panel-heading">
        <div>
          <div class="section-kicker">今日进度</div>
          <h2>准备情况一眼看清</h2>
        </div>
        <button class="ghost-button" type="button" data-refresh-all>刷新数据</button>
      </div>
      <div class="metric-grid">
        <article class="metric-card">
          <span>名册人数</span>
          <strong>${state.faces.length}</strong>
        </article>
        <article class="metric-card">
          <span>已绑定设备</span>
          <strong>${state.devices.length}</strong>
        </article>
        <article class="metric-card">
          <span>已发布版本</span>
          <strong>${state.packages.length}</strong>
        </article>
        <article class="metric-card">
          <span>已采集样本</span>
          <strong>${state.faces.reduce((total, item) => total + Number(item.sampleCount || 0), 0)}</strong>
        </article>
      </div>
    </section>

    <section class="panel panel-split">
      <div>
        <div class="section-kicker">使用流程</div>
        <h2>按顺序完成即可投入使用</h2>
        <div class="timeline">
          <article>
            <span>01</span>
            <div>
              <h3>打开摄像头</h3>
              <p>把人脸放进取景框，连续采集 3 到 5 张样本。</p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <h3>保存到名册</h3>
              <p>填写姓名、权重和标签，常用班级可以直接写在标签里。</p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <h3>绑定教室设备</h3>
              <p>把设备码和教室名称对应起来，选择当前使用的版本。</p>
            </div>
          </article>
          <article>
            <span>04</span>
            <div>
              <h3>发布新版本</h3>
              <p>发布后，桌面端会在下次同步时拿到最新人脸包。</p>
            </div>
          </article>
        </div>
      </div>
      <div class="summary-stack">
        <article class="summary-card">
          <div class="summary-label">当前版本</div>
          <h3>${latestPackage ? escapeHtml(latestPackage.version) : "尚未发布"}</h3>
          <p>${latestPackage ? escapeHtml(latestPackage.notes || "已准备推送到设备") : "录入完成后即可发布。"}</p>
        </article>
        <article class="summary-card">
          <div class="summary-label">最近绑定</div>
          <h3>${latestDevice ? escapeHtml(latestDevice.classroom) : "暂无设备"}</h3>
          <p>${latestDevice ? escapeHtml(latestDevice.deviceCode) : "先去设备页绑定设备。"}</p>
        </article>
      </div>
    </section>

    <section class="panel">
      <div class="panel-heading">
        <div>
          <div class="section-kicker">最近录入</div>
          <h2>名册变化</h2>
        </div>
        <button class="ghost-button" type="button" data-quick-view="enroll">继续添加</button>
      </div>
      <div class="card-grid">
        ${recentFaces.map((face) => `
          <article class="face-card">
            <div class="avatar-pill">${escapeHtml(face.displayName.slice(0, 1))}</div>
            <div>
              <h3>${escapeHtml(face.displayName)}</h3>
              <p>${escapeHtml(face.personId)}</p>
            </div>
            <div class="face-meta">
              <span>${face.descriptorCount} 个特征样本</span>
              <span>${escapeHtml(face.tags.join(" / ") || "未分类")}</span>
            </div>
            <button class="ghost-button compact" type="button" data-edit-face="${escapeHtml(face.personId)}">继续录入</button>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderEnroll() {
  const captureCount = state.camera.captures.length;

  return `
    <section class="panel enroll-layout">
      <div class="camera-shell">
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">实时取景</div>
            <h2>像识别时一样完成采样</h2>
          </div>
          <div class="inline-actions">
            ${state.camera.enabled
              ? `<button class="ghost-button" type="button" data-stop-camera>关闭摄像头</button>`
              : `<button class="primary-button" type="button" data-start-camera>打开摄像头</button>`}
            <button class="ghost-button" type="button" data-capture-frame ${state.camera.enabled ? "" : "disabled"}>采集当前画面</button>
          </div>
        </div>
        <div class="camera-stage">
          <video class="camera-preview" data-camera-preview></video>
          <div class="camera-overlay">
            <div class="scan-frame"></div>
            <div class="scan-line"></div>
            <div class="camera-tip">${state.camera.enabled ? "请保持人脸在方框中，正脸和微侧脸各采一张。" : "点击“打开摄像头”开始录入。"}</div>
          </div>
        </div>
        <div class="capture-toolbar">
          <span class="capture-count">已采集 ${captureCount} / 5</span>
          <button class="ghost-button compact" type="button" data-clear-captures ${captureCount ? "" : "disabled"}>清空样本</button>
        </div>
        <div class="capture-grid">
          ${state.camera.captures.map((capture, index) => `
            <article class="capture-card">
              <img src="${capture.previewUrl}" alt="capture ${index + 1}" />
              <button class="capture-remove" type="button" data-remove-capture="${capture.id}">删除</button>
            </article>
          `).join("") || `<div class="empty-card">采集后的样本会显示在这里。</div>`}
        </div>
      </div>

      <form class="panel form-panel" data-enroll-form>
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">录入信息</div>
            <h2>保存到名册</h2>
          </div>
        </div>
        <div class="form-grid">
          <label class="field">
            <span>姓名</span>
            <input name="displayName" type="text" value="${escapeHtml(state.draft.displayName)}" placeholder="例如：张三" required />
          </label>
          <label class="field">
            <span>编号</span>
            <input name="personId" type="text" value="${escapeHtml(state.draft.personId)}" placeholder="可留空自动生成" />
          </label>
          <label class="field">
            <span>标签</span>
            <input name="tags" type="text" value="${escapeHtml(state.draft.tags)}" placeholder="例如：class-a, team-red" />
          </label>
          <label class="field">
            <span>基础权重</span>
            <input name="baseWeight" type="number" min="1" max="10" step="1" value="${escapeHtml(state.draft.baseWeight)}" />
          </label>
          <label class="field field-wide">
            <span>采样说明</span>
            <textarea name="sampleNotes" placeholder="例如：正脸 / 佩戴眼镜 / 教室光线">${escapeHtml(state.draft.sampleNotes)}</textarea>
          </label>
          <div class="switch-row field-wide">
            <label><input name="preferred" type="checkbox" ${state.draft.preferred ? "checked" : ""} /> 优先抽取</label>
            <label><input name="ignored" type="checkbox" ${state.draft.ignored ? "checked" : ""} /> 暂不参与</label>
          </div>
        </div>
        <div class="notice-card">
          建议每个人至少采集 3 张，最多 5 张，尽量覆盖正脸、微侧脸和不同表情。
        </div>
        <div class="inline-actions">
          <button class="primary-button" type="submit">保存录入</button>
          <button class="ghost-button" type="button" data-reset-draft>重新开始</button>
        </div>
      </form>
    </section>
  `;
}

function renderRoster() {
  const faces = filteredFaces();

  return `
    <section class="panel">
      <div class="panel-heading">
        <div>
          <div class="section-kicker">人脸名册</div>
          <h2>查看和继续补录</h2>
        </div>
        <div class="inline-actions">
          <input class="search-input" data-search-input type="search" value="${escapeHtml(state.searchQuery)}" placeholder="搜索姓名、编号或标签" />
          <button class="primary-button" type="button" data-quick-view="enroll">新增成员</button>
        </div>
      </div>
      <div class="roster-grid">
        ${faces.map((face) => `
          <article class="roster-card">
            <div class="roster-card-top">
              <div class="avatar-pill large">${escapeHtml(face.displayName.slice(0, 1))}</div>
              <div>
                <h3>${escapeHtml(face.displayName)}</h3>
                <p class="mono">${escapeHtml(face.personId)}</p>
              </div>
            </div>
            <div class="chip-row">
              <span class="chip">${face.descriptorCount} 个特征</span>
              <span class="chip">${face.sampleCount} 张样本</span>
              <span class="chip">${face.baseWeight} 倍权重</span>
              ${face.preferred ? `<span class="chip accent">优先</span>` : ""}
              ${face.ignored ? `<span class="chip muted">暂停</span>` : ""}
            </div>
            <p class="card-copy">${escapeHtml(face.tags.join(" / ") || "未设置标签")}</p>
            <div class="card-footer">
              <span>更新于 ${escapeHtml(formatDate(face.updatedAt))}</span>
              <button class="ghost-button compact" type="button" data-edit-face="${escapeHtml(face.personId)}">继续录入</button>
            </div>
          </article>
        `).join("") || `<div class="empty-card">没有匹配到结果。</div>`}
      </div>
    </section>
  `;
}

function renderDevices() {
  const activePackage = state.packages.find((item) => item.isActive) || state.packages[0];

  return `
    <section class="panel panel-split">
      <form class="form-panel" data-device-form>
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">设备绑定</div>
            <h2>把设备连到教室</h2>
          </div>
        </div>
        <div class="form-grid">
          <label class="field">
            <span>设备码</span>
            <input name="deviceCode" type="text" placeholder="从桌面端复制完整设备码" required />
          </label>
          <label class="field">
            <span>教室或班级</span>
            <input name="classroom" type="text" placeholder="例如：Room 301 / 一年级一班" required />
          </label>
          <label class="field">
            <span>使用版本</span>
            <input name="packageVersion" type="text" value="${escapeHtml(activePackage?.version || "")}" placeholder="例如：2026.06.18.2" required />
          </label>
          <div class="switch-row">
            <label><input name="devModeEnabled" type="checkbox" /> 调试可视化</label>
          </div>
        </div>
        <div class="inline-actions">
          <button class="primary-button" type="submit">保存设备</button>
        </div>
      </form>

      <div class="panel">
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">已绑定设备</div>
            <h2>教室列表</h2>
          </div>
        </div>
        <div class="device-list">
          ${state.devices.map((device) => `
            <article class="device-card">
              <div class="device-top">
                <h3>${escapeHtml(device.classroom)}</h3>
                <span class="device-state ${device.devModeEnabled ? "accent" : ""}">${device.devModeEnabled ? "调试开" : "正常模式"}</span>
              </div>
              <p class="mono">${escapeHtml(device.deviceCode)}</p>
              <div class="device-meta">版本：${escapeHtml(device.packageVersion)}</div>
              <div class="device-meta">绑定时间：${escapeHtml(formatDate(device.pairedAt))}</div>
              <div class="device-meta">最近同步：${escapeHtml(formatDate(device.lastSeenAt))}</div>
            </article>
          `).join("") || `<div class="empty-card">还没有绑定任何设备。</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderPublish() {
  return `
    <section class="panel panel-split">
      <form class="form-panel" data-publish-form>
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">发布新版本</div>
            <h2>把最新名册推送到设备</h2>
          </div>
        </div>
        <div class="form-grid">
          <label class="field">
            <span>版本号</span>
            <input name="version" type="text" value="${escapeHtml(suggestVersion())}" />
          </label>
          <label class="field field-wide">
            <span>说明</span>
            <textarea name="notes" placeholder="例如：新增 2 人，更新 1 人样本"></textarea>
          </label>
        </div>
        <div class="inline-actions">
          <button class="primary-button" type="submit">发布当前版本</button>
        </div>
      </form>

      <form class="form-panel" data-rollback-form>
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">恢复旧版本</div>
            <h2>当场切回稳定包</h2>
          </div>
        </div>
        <div class="form-grid">
          <label class="field">
            <span>选择版本</span>
            <select name="rollbackVersion">
              <option value="">请选择版本</option>
              ${state.packages.map((pkg) => `
                <option value="${escapeHtml(pkg.version)}">${escapeHtml(pkg.version)}${pkg.isActive ? "（当前）" : ""}</option>
              `).join("")}
            </select>
          </label>
        </div>
        <div class="inline-actions">
          <button class="ghost-button" type="submit">恢复所选版本</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <div class="panel-heading">
        <div>
          <div class="section-kicker">版本记录</div>
          <h2>发布历史</h2>
        </div>
      </div>
      <div class="package-table">
        ${state.packages.map((pkg) => `
          <article class="package-row ${pkg.isActive ? "active" : ""}">
            <div>
              <h3>${escapeHtml(pkg.version)}</h3>
              <p>${escapeHtml(pkg.notes || "无备注")}</p>
            </div>
            <div class="package-meta">
              <span>${pkg.peopleCount} 人</span>
              <span>${escapeHtml(formatDate(pkg.publishedAt))}</span>
              <span>${escapeHtml(pkg.operator || "未知操作人")}</span>
              <span>${pkg.isActive ? "当前使用中" : "历史版本"}</span>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderSettings() {
  return `
    <section class="panel panel-split">
      <form class="form-panel" data-login-form>
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">账号</div>
            <h2>${isLoggedIn() ? "当前已连接" : "登录后开始同步"}</h2>
          </div>
          ${isLoggedIn() ? `<button class="ghost-button" type="button" data-logout>退出</button>` : ""}
        </div>
        ${isLoggedIn()
          ? `
            <div class="notice-card">
              当前账号：${escapeHtml(state.sessionEmail || "未命名账号")}<br />
              如需重新连接其他服务地址，可以在右侧修改。
            </div>
          `
          : `
            <div class="form-grid">
              <label class="field">
                <span>邮箱</span>
                <input name="email" type="email" placeholder="admin@example.com" required />
              </label>
              <label class="field">
                <span>密码</span>
                <input name="password" type="password" placeholder="输入登录密码" required />
              </label>
            </div>
            <div class="inline-actions">
              <button class="primary-button" type="submit">登录并同步</button>
            </div>
          `}
      </form>

      <form class="form-panel" data-settings-form>
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">连接</div>
            <h2>服务地址</h2>
          </div>
        </div>
        <div class="form-grid">
          <label class="field field-wide">
            <span>API 地址</span>
            <input name="apiBaseUrl" type="text" value="${escapeHtml(state.apiBaseUrl)}" placeholder="https://roll.underflo.ink" />
          </label>
        </div>
        <div class="inline-actions">
          <button class="ghost-button" type="submit">保存地址</button>
          <button class="ghost-button" type="button" data-refresh-all>立即同步</button>
        </div>
      </form>
    </section>
  `;
}

function renderMain() {
  switch (state.activeView) {
    case "enroll":
      return renderEnroll();
    case "roster":
      return renderRoster();
    case "devices":
      return renderDevices();
    case "publish":
      return renderPublish();
    case "settings":
      return renderSettings();
    default:
      return renderHome();
  }
}

function renderLoginHint() {
  if (isLoggedIn()) {
    return "";
  }

  return `
    <section class="login-hint">
      <p>你还没有登录。可以先浏览页面结构，真正保存数据前请到“设置”页完成登录。</p>
      <button class="primary-button" type="button" data-quick-view="settings">去登录</button>
    </section>
  `;
}

function render() {
  app.innerHTML = `
    ${renderTopbar()}
    ${renderLoginHint()}
    <section class="workspace">
      ${renderNav()}
      <main class="content">
        ${state.loading ? `<div class="loading-banner">正在处理，请稍候…</div>` : ""}
        ${renderMain()}
      </main>
    </section>
  `;

  bindEvents();
  attachCameraStream();
}

function bindEvents() {
  document.querySelectorAll("[data-nav-view]").forEach((button) => {
    button.addEventListener("click", () => {
      switchView(button.dataset.navView);
    });
  });

  document.querySelectorAll("[data-quick-view]").forEach((button) => {
    button.addEventListener("click", () => {
      switchView(button.dataset.quickView);
    });
  });

  document.querySelector("[data-settings-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    state.apiBaseUrl = normalizeApiBaseUrl(formData.get("apiBaseUrl"));
    persistSession();
    setStatus(`已切换服务地址到 ${state.apiBaseUrl}。`, "success");
  });

  document.querySelector("[data-login-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await login(
      String(formData.get("email") || "").trim(),
      String(formData.get("password") || "").trim()
    );
  });

  document.querySelector("[data-logout]")?.addEventListener("click", logout);
  document.querySelectorAll("[data-refresh-all]").forEach((button) => {
    button.addEventListener("click", () => {
      refreshAll({ silent: false });
    });
  });
  document.querySelector("[data-start-camera]")?.addEventListener("click", startCamera);
  document.querySelector("[data-stop-camera]")?.addEventListener("click", stopCamera);
  document.querySelector("[data-capture-frame]")?.addEventListener("click", captureFrame);
  document.querySelector("[data-clear-captures]")?.addEventListener("click", clearCaptures);
  document.querySelector("[data-reset-draft]")?.addEventListener("click", () => {
    stopCameraTracks();
    state.camera.enabled = false;
    resetDraft();
    render();
  });

  document.querySelector("[data-enroll-form]")?.addEventListener("submit", handleEnrollSubmit);
  document.querySelector("[data-device-form]")?.addEventListener("submit", handleDeviceSubmit);
  document.querySelector("[data-publish-form]")?.addEventListener("submit", handlePublishSubmit);
  document.querySelector("[data-rollback-form]")?.addEventListener("submit", handleRollbackSubmit);

  document.querySelector("[data-search-input]")?.addEventListener("input", (event) => {
    state.searchQuery = event.currentTarget.value;
    render();
  });

  document.querySelectorAll("[data-edit-face]").forEach((button) => {
    button.addEventListener("click", () => {
      const record = state.faces.find((item) => item.personId === button.dataset.editFace);
      openEnrollDraft(record || null);
    });
  });

  document.querySelectorAll("[data-remove-capture]").forEach((button) => {
    button.addEventListener("click", () => {
      removeCapture(button.dataset.removeCapture);
    });
  });
}

async function init() {
  render();

  if (isLoggedIn()) {
    await refreshAll({ silent: false });
  }
}

window.addEventListener("beforeunload", () => {
  stopCameraTracks();
  revokeCaptureUrls();
});

init();
