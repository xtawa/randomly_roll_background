import "./styles.css";

const NAV_ITEMS = [
  { key: "home", label: "首页" },
  { key: "enroll", label: "录入人脸" },
  { key: "roster", label: "名册" },
  { key: "devices", label: "设备" },
  { key: "groups", label: "账号组", adminOnly: true },
  { key: "publish", label: "发布", adminOnly: true },
  { key: "settings", label: "设置" }
];

const LOCAL_KEYS = {
  apiBaseUrl: "admin-console-api-base-url",
  token: "admin-console-token",
  email: "roll-console-email"
};

const DRAFT_MODES = {
  create: "create",
  edit: "edit",
  append: "append"
};

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

const app = document.getElementById("app");

function getDefaultApiBaseUrl() {
  if (typeof window !== "undefined" && /^https?:$/i.test(window.location.protocol)) {
    return window.location.origin;
  }

  return "http://127.0.0.1:3000";
}

function resolveInitialApiBaseUrl() {
  const savedValue = window.localStorage.getItem(LOCAL_KEYS.apiBaseUrl);
  const normalizedSavedValue = String(savedValue || "").trim().replace(/\/+$/, "");

  if (!normalizedSavedValue || normalizedSavedValue === "https://roll.underflo.ink") {
    return normalizeApiBaseUrl(getDefaultApiBaseUrl());
  }

  return normalizeApiBaseUrl(normalizedSavedValue);
}

function buildEmptyDraft() {
  return {
    mode: DRAFT_MODES.create,
    personId: "",
    displayName: "",
    baseWeight: 1,
    tags: "",
    preferred: false,
    ignored: false,
    sampleNotes: "正脸 / 微侧脸 / 自然表情"
  };
}

function buildEmptyDeviceDraft() {
  return {
    deviceCode: "",
    classroom: "",
    devModeEnabled: false
  };
}

const state = {
  activeView: "enroll",
  apiBaseUrl: resolveInitialApiBaseUrl(),
  authToken: window.localStorage.getItem(LOCAL_KEYS.token) || "",
  sessionEmail: window.localStorage.getItem(LOCAL_KEYS.email) || "",
  account: null,
  authMode: "login",
  authContext: {
    email: "",
    verificationCode: "",
    resetToken: ""
  },
  registrationGuard: {
    configLoadedForApiBaseUrl: "",
    loading: false,
    loadError: "",
    captchaEnabled: false,
    turnstileSiteKey: "",
    registrationLimitPerIp: 2,
    turnstileToken: "",
    turnstileWidgetId: null
  },
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
  deviceDraft: buildEmptyDeviceDraft(),
  deviceScanner: {
    active: false,
    supported: null,
    error: "",
    lastDetectedCode: ""
  },
  draft: buildEmptyDraft(),
  faces: [],
  devices: [],
  packages: [],
  groups: [],
  groupUsers: [],
  groupDevices: []
};

let liveStream = null;
let turnstileScriptPromise = null;
let deviceScannerStream = null;
let deviceScannerTimer = 0;
let deviceBarcodeDetector = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeApiBaseUrl(value) {
  const rawValue = String(value || "").trim() || getDefaultApiBaseUrl();
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

function normalizeGroups(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => ({
      id: String(item?.id || ""),
      name: String(item?.name || "")
    }))
    .filter((item) => item.id && item.name);
}

function formatGroupNames(groups, emptyLabel = "未加入账号组") {
  const names = normalizeGroups(groups).map((group) => group.name);
  return names.length > 0 ? names.join(" / ") : emptyLabel;
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

function stopDeviceScannerTracks() {
  if (deviceScannerTimer) {
    window.clearTimeout(deviceScannerTimer);
    deviceScannerTimer = 0;
  }

  if (!deviceScannerStream) {
    return;
  }

  deviceScannerStream.getTracks().forEach((track) => {
    track.stop();
  });
  deviceScannerStream = null;
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
    const error = new Error(message);
    error.status = response.status;
    error.code = typeof payload === "object" ? payload?.code : "";

    if (response.status === 401 && error.code === "AUTH_INVALID_TOKEN") {
      clearSession();
      state.authMode = "login";
    }

    throw error;
  }

  return payload;
}

function resetTurnstileState() {
  const widgetId = state.registrationGuard.turnstileWidgetId;

  if (widgetId !== null && typeof window !== "undefined" && window.turnstile?.remove) {
    try {
      window.turnstile.remove(widgetId);
    } catch {}
  }

  state.registrationGuard.turnstileWidgetId = null;
  state.registrationGuard.turnstileToken = "";
}

function isRegisterProtectionReady() {
  return state.registrationGuard.captchaEnabled && Boolean(state.registrationGuard.turnstileSiteKey);
}

function renderRegistrationGuard() {
  if (state.registrationGuard.loading) {
    return `<div class="notice-card">正在加载 Cloudflare 人机验证配置…</div>`;
  }

  if (state.registrationGuard.loadError) {
    return `<div class="notice-card notice-card-danger">${escapeHtml(state.registrationGuard.loadError)}</div>`;
  }

  if (!isRegisterProtectionReady()) {
    return `<div class="notice-card notice-card-danger">管理员尚未配置 Cloudflare Turnstile，当前不能注册新账号。</div>`;
  }

  return `
    <div class="turnstile-panel">
      <span class="turnstile-label">人机验证</span>
      <div class="turnstile-widget" id="turnstile-register-widget"></div>
      <p class="turnstile-copy">完成 Cloudflare 验证后才可注册。每个 IP 最多创建 ${state.registrationGuard.registrationLimitPerIp} 个账号。</p>
    </div>
  `;
}

async function loadRegisterConfig({ force = false, silent = true } = {}) {
  if (state.registrationGuard.loading) {
    return;
  }

  if (!force && state.registrationGuard.configLoadedForApiBaseUrl === state.apiBaseUrl) {
    return;
  }

  state.registrationGuard.loading = true;
  state.registrationGuard.loadError = "";
  resetTurnstileState();

  try {
    const payload = await requestApi("/api/auth/register-config");
    state.registrationGuard.configLoadedForApiBaseUrl = state.apiBaseUrl;
    state.registrationGuard.captchaEnabled = Boolean(payload.captchaEnabled);
    state.registrationGuard.turnstileSiteKey = String(payload.turnstileSiteKey || "");
    state.registrationGuard.registrationLimitPerIp = Number(payload.registrationLimitPerIp || 2);
    state.registrationGuard.loading = false;

    if (!isLoggedIn()) {
      render();
    }
  } catch (error) {
    state.registrationGuard.loading = false;
    state.registrationGuard.captchaEnabled = false;
    state.registrationGuard.turnstileSiteKey = "";
    state.registrationGuard.loadError = `注册验证配置读取失败：${error.message}`;

    if (!isLoggedIn()) {
      render();
    }

    if (!silent) {
      setStatus(state.registrationGuard.loadError, "error");
    }
  }
}

function loadTurnstileScript() {
  if (typeof window !== "undefined" && window.turnstile) {
    return Promise.resolve(window.turnstile);
  }

  if (turnstileScriptPromise) {
    return turnstileScriptPromise;
  }

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[data-turnstile-script="true"]');
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(window.turnstile), { once: true });
      existingScript.addEventListener("error", () => {
        turnstileScriptPromise = null;
        reject(new Error("Turnstile script failed to load."));
      }, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.dataset.turnstileScript = "true";
    script.addEventListener("load", () => resolve(window.turnstile), { once: true });
    script.addEventListener("error", () => {
      turnstileScriptPromise = null;
      reject(new Error("Turnstile script failed to load."));
    }, { once: true });
    document.head.append(script);
  });

  return turnstileScriptPromise;
}

async function mountTurnstileWidget() {
  if (isLoggedIn() || state.loading || state.authMode !== "register" || !isRegisterProtectionReady()) {
    return;
  }

  if (state.registrationGuard.turnstileWidgetId !== null) {
    return;
  }

  const container = document.getElementById("turnstile-register-widget");
  if (!container) {
    return;
  }

  try {
    await loadTurnstileScript();

    if (isLoggedIn() || state.loading || state.authMode !== "register" || state.registrationGuard.turnstileWidgetId !== null) {
      return;
    }

    state.registrationGuard.turnstileWidgetId = window.turnstile.render("#turnstile-register-widget", {
      sitekey: state.registrationGuard.turnstileSiteKey,
      theme: "light",
      callback: (token) => {
        state.registrationGuard.turnstileToken = token;
      },
      "expired-callback": () => {
        state.registrationGuard.turnstileToken = "";
      },
      "error-callback": () => {
        state.registrationGuard.turnstileToken = "";
      }
    });
  } catch {
    state.registrationGuard.captchaEnabled = false;
    state.registrationGuard.loadError = "Cloudflare 人机验证脚本加载失败，请稍后重试。";
    render();
  }
}

async function ensureRegisterProtection() {
  await loadRegisterConfig({ silent: true });

  if (state.authMode === "register" && isRegisterProtectionReady()) {
    await mountTurnstileWidget();
  }
}

function normalizeFaceRecord(item) {
  const groups = normalizeGroups(item.groups);
  return {
    personId: item.personId,
    displayName: item.displayName,
    preferred: Boolean(item.preferred),
    ignored: Boolean(item.ignored),
    baseWeight: Number(item.baseWeight || 1),
    tags: Array.isArray(item.tags) ? item.tags : [],
    descriptorCount: Number(item.descriptorCount || item.descriptors || 0),
    sampleCount: Number(item.sampleCount || item.descriptorCount || 0),
    updatedAt: item.updatedAt || new Date().toISOString(),
    ownerEmail: item.ownerEmail || "",
    groupId: item.groupId || groups[0]?.id || "",
    groups
  };
}

function normalizeDeviceRecord(item) {
  return {
    deviceCode: item.deviceCode,
    classroom: item.classroom || "未命名教室",
    packageVersion: item.packageVersion || "",
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
    operator: item.operator || state.sessionEmail || "operator@example.com",
    groupId: item.groupId || "",
    groupName: item.groupName || ""
  };
}

function renderPackageOptions(selectedVersion = "", emptyLabel = "暂不指定版本") {
  return `
    <option value="">${escapeHtml(emptyLabel)}</option>
    ${state.packages.map((pkg) => `
      <option value="${escapeHtml(pkg.version)}" ${pkg.version === selectedVersion ? "selected" : ""}>
        ${escapeHtml(pkg.version)}${pkg.isActive ? "（当前）" : ""}
      </option>
    `).join("")}
  `;
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

async function refreshGroups() {
  const payload = await requestApi("/api/admin/groups");
  state.groups = payload.items || [];
  state.groupUsers = (payload.users || []).map((user) => ({
    ...user,
    groupIds: Array.isArray(user.groupIds) ? user.groupIds.map(String) : []
  }));
  state.groupDevices = payload.devices || [];
}

async function refreshAll({ silent = false } = {}) {
  if (!isLoggedIn()) {
    render();
    return;
  }

  if (!silent) {
    setLoading(true);
  }

  const tasks = [refreshFaces(), refreshDevices()];
  if (state.account?.role === "admin") {
    tasks.push(refreshPackages());
  }
  if (state.account?.role === "admin") {
    tasks.push(refreshGroups());
  }
  const results = await Promise.allSettled(tasks);
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

function removeLocalFace(personId) {
  state.faces = state.faces.filter((item) => item.personId !== personId);
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
    state.account = payload.user || null;
    persistSession();
    state.status = {
      tone: "success",
      message: "登录成功，正在读取名册和设备信息。"
    };
    await loadAccount();
    render();
    await refreshAll({ silent: false });
  } catch (error) {
    state.loading = false;
    setStatus(`登录失败：${error.message}`, "error");
  }
}

function logout() {
  clearSession();
  state.authMode = "login";
  state.status = { tone: "success", message: "已安全退出当前账号。" };
  render();
}

function clearSession() {
  stopCameraTracks();
  stopDeviceScannerTracks();
  state.camera.enabled = false;
  state.deviceScanner.active = false;
  state.deviceScanner.error = "";
  state.deviceScanner.lastDetectedCode = "";
  state.authToken = "";
  state.sessionEmail = "";
  state.account = null;
  state.deviceDraft = buildEmptyDeviceDraft();
  state.faces = [];
  state.devices = [];
  state.packages = [];
  state.groups = [];
  state.groupUsers = [];
  state.groupDevices = [];
  persistSession();
}

async function loadAccount() {
  const account = await requestApi("/api/auth/me");
  state.account = {
    ...account,
    groups: normalizeGroups(account.groups),
    group: account.group && account.group.id ? account.group : null
  };
  state.sessionEmail = account.email;
  persistSession();
}

async function handleRegister(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");
  const turnstileToken = state.registrationGuard.turnstileToken;

  if (password !== confirmPassword) {
    setStatus("两次输入的密码不一致。", "error");
    return;
  }

  if (!isRegisterProtectionReady()) {
    setStatus("当前服务尚未配置 Cloudflare 人机验证，暂时不能注册。", "error");
    return;
  }

  if (!turnstileToken) {
    setStatus("请先完成人机验证，再提交注册。", "error");
    return;
  }

  setLoading(true);
  try {
    const payload = await requestApi("/api/auth/register", {
      method: "POST",
      body: { email, password, turnstileToken }
    });
    state.authContext.email = email;
    state.authContext.verificationCode = payload.verificationCode || "";
    state.authMode = "verify";
    resetTurnstileState();
    state.loading = false;
    setStatus("账号已创建，请完成邮箱验证。", "success");
  } catch (error) {
    resetTurnstileState();
    state.loading = false;
    setStatus(`注册失败：${error.message}`, "error");
  }
}

async function handleVerify(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const email = String(formData.get("email") || "").trim();
  const code = String(formData.get("code") || "").trim();

  setLoading(true);
  try {
    await requestApi("/api/auth/verify-email", { method: "POST", body: { email, code } });
    state.authMode = "login";
    state.loading = false;
    setStatus("邮箱验证完成，现在可以登录。", "success");
  } catch (error) {
    state.loading = false;
    setStatus(`验证失败：${error.message}`, "error");
  }
}

async function handleForgotPassword(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const email = String(formData.get("email") || "").trim();

  setLoading(true);
  try {
    const payload = await requestApi("/api/auth/forgot-password", { method: "POST", body: { email } });
    state.authContext.email = email;
    state.authContext.resetToken = payload.resetToken || "";
    state.authMode = "reset";
    state.loading = false;
    setStatus("重置请求已受理，请设置新密码。", "success");
  } catch (error) {
    state.loading = false;
    setStatus(`请求失败：${error.message}`, "error");
  }
}

async function handleResetPassword(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const token = String(formData.get("token") || "").trim();
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (password !== confirmPassword) {
    setStatus("两次输入的密码不一致。", "error");
    return;
  }

  setLoading(true);
  try {
    await requestApi("/api/auth/reset-password", { method: "POST", body: { token, password } });
    state.authMode = "login";
    state.loading = false;
    setStatus("密码已重置，请使用新密码登录。", "success");
  } catch (error) {
    state.loading = false;
    setStatus(`重置失败：${error.message}`, "error");
  }
}

async function handleChangePassword(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const currentPassword = String(formData.get("currentPassword") || "");
  const newPassword = String(formData.get("newPassword") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (newPassword !== confirmPassword) {
    setStatus("两次输入的新密码不一致。", "error");
    return;
  }

  setLoading(true);
  try {
    await requestApi("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword }
    });
    event.currentTarget.reset();
    state.loading = false;
    setStatus("密码修改成功。", "success");
  } catch (error) {
    state.loading = false;
    setStatus(`修改失败：${error.message}`, "error");
  }
}

function resetDraft() {
  revokeCaptureUrls();
  state.camera.captures = [];
  state.draft = buildEmptyDraft();
}

function getDraftConfig() {
  switch (state.draft.mode) {
    case DRAFT_MODES.edit:
      return {
        formKicker: "修改资料",
        formTitle: "更新成员信息",
        formCopy: "可以只修改资料，也可以顺手补录几张新样本。",
        cameraTitle: "按需补录样本",
        cameraCopy: "编辑资料时不强制采样；如果要同步补录，直接打开摄像头即可。",
        idleCameraTip: "修改资料时可不采样，如需补录再打开摄像头。",
        activeCameraTip: "如果要补录样本，建议补一到三张不同角度的新照片。",
        notice: "当前是修改模式。已有成员的编号会保持不变；不采集新样本也可以直接保存。",
        submitLabel: "保存修改",
        resetLabel: "取消修改",
        personIdReadonly: true
      };
    case DRAFT_MODES.append:
      return {
        formKicker: "补录样本",
        formTitle: "为成员补充新样本",
        formCopy: "成员资料可一起调整，但本次至少需要补录 1 张新样本。",
        cameraTitle: "采集补充样本",
        cameraCopy: "建议覆盖新的角度、表情或光线条件，提升识别稳定性。",
        idleCameraTip: "点击“打开摄像头”开始补录样本。",
        activeCameraTip: "请保持人脸在方框中，至少补录一张新样本。",
        notice: "当前是补录模式。建议补录 1 到 3 张新样本，避免和历史样本过度重复。",
        submitLabel: "保存补录",
        resetLabel: "取消补录",
        personIdReadonly: true
      };
    default:
      return {
        formKicker: "录入信息",
        formTitle: "保存到名册",
        formCopy: "填写成员资料，并完成首次样本采集。",
        cameraTitle: "像识别时一样完成采样",
        cameraCopy: "这里就是实时录入入口。打开摄像头后，直接对着镜头采样。",
        idleCameraTip: "点击“打开摄像头”开始录入。",
        activeCameraTip: "请保持人脸在方框中，正脸和微侧脸各采一张。",
        notice: "建议每个成员首次录入采集 3 到 5 张样本，尽量覆盖正脸、微侧脸和不同表情。",
        submitLabel: "保存录入",
        resetLabel: "重新开始",
        personIdReadonly: false
      };
  }
}

function openEnrollDraft(record = null, mode = DRAFT_MODES.create) {
  revokeCaptureUrls();
  state.camera.captures = [];

  if (record) {
    state.draft = {
      mode,
      personId: record.personId,
      displayName: record.displayName,
      baseWeight: record.baseWeight,
      tags: record.tags.join(", "),
      preferred: record.preferred,
      ignored: record.ignored,
      sampleNotes: mode === DRAFT_MODES.append ? "补充新样本" : "仅修改资料"
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

  if (state.activeView === "devices" && nextView !== "devices") {
    stopDeviceScannerTracks();
    state.deviceScanner.active = false;
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

function attachDeviceScannerStream() {
  const video = document.querySelector("[data-device-scanner-preview]");
  if (!video || !deviceScannerStream) {
    return;
  }

  if (video.srcObject !== deviceScannerStream) {
    video.srcObject = deviceScannerStream;
  }

  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.play().catch(() => {});
}

async function ensureDeviceScannerSupport() {
  if (state.deviceScanner.supported === true && deviceBarcodeDetector) {
    return true;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    state.deviceScanner.supported = false;
    state.deviceScanner.error = "当前浏览器不支持摄像头扫码，请手动输入设备码。";
    return false;
  }

  if (typeof window === "undefined" || typeof window.BarcodeDetector === "undefined") {
    state.deviceScanner.supported = false;
    state.deviceScanner.error = "当前浏览器不支持自动扫码，请手动输入设备码。";
    return false;
  }

  try {
    let detector;
    if (typeof window.BarcodeDetector.getSupportedFormats === "function") {
      const supportedFormats = await window.BarcodeDetector.getSupportedFormats();
      const preferredFormats = ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e"];
      const formats = preferredFormats.filter((format) => supportedFormats.includes(format));
      detector = formats.length > 0
        ? new window.BarcodeDetector({ formats })
        : new window.BarcodeDetector();
    } else {
      detector = new window.BarcodeDetector({ formats: ["qr_code", "code_128", "code_39"] });
    }

    deviceBarcodeDetector = detector;
    state.deviceScanner.supported = true;
    state.deviceScanner.error = "";
    return true;
  } catch {
    state.deviceScanner.supported = false;
    state.deviceScanner.error = "当前浏览器不支持自动扫码，请手动输入设备码。";
    return false;
  }
}

function scheduleDeviceScannerLoop() {
  if (!state.deviceScanner.active) {
    return;
  }

  deviceScannerTimer = window.setTimeout(() => {
    void scanDeviceCodeFrame();
  }, 180);
}

async function scanDeviceCodeFrame() {
  if (!state.deviceScanner.active || !deviceScannerStream || !deviceBarcodeDetector) {
    return;
  }

  const video = document.querySelector("[data-device-scanner-preview]");
  if (!video || video.readyState < 2) {
    scheduleDeviceScannerLoop();
    return;
  }

  try {
    const codes = await deviceBarcodeDetector.detect(video);
    const match = codes.find((item) => String(item?.rawValue || "").trim());

    if (match) {
      const deviceCode = String(match.rawValue || "").trim();
      state.deviceDraft.deviceCode = deviceCode;
      state.deviceScanner.lastDetectedCode = deviceCode;
      stopDeviceScannerTracks();
      state.deviceScanner.active = false;
      render();
      setStatus(`已识别设备码 ${deviceCode}，已自动填入。`, "success");
      return;
    }
  } catch {}

  scheduleDeviceScannerLoop();
}

async function startDeviceScanner() {
  const supported = await ensureDeviceScannerSupport();
  if (!supported) {
    render();
    setStatus(state.deviceScanner.error, "error");
    return;
  }

  try {
    stopCameraTracks();
    state.camera.enabled = false;
    stopDeviceScannerTracks();

    deviceScannerStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    state.deviceScanner.active = true;
    state.deviceScanner.error = "";
    render();
    attachDeviceScannerStream();
    scheduleDeviceScannerLoop();
    setStatus("后置摄像头已开启，请将设备码放入取景框。", "success");
  } catch (error) {
    stopDeviceScannerTracks();
    state.deviceScanner.active = false;
    state.deviceScanner.error = `无法打开扫码摄像头：${error.message}`;
    render();
    setStatus(state.deviceScanner.error, "error");
  }
}

function stopDeviceScanner() {
  stopDeviceScannerTracks();
  state.deviceScanner.active = false;
  render();
  setStatus("设备扫码已停止。", "neutral");
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

function updateDeviceDraftField(fieldName, value) {
  state.deviceDraft = {
    ...state.deviceDraft,
    [fieldName]: value
  };
}

async function handleEnrollSubmit(event) {
  event.preventDefault();

  const formData = new FormData(event.currentTarget);
  const draftMode = state.draft.mode || DRAFT_MODES.create;
  const displayName = String(formData.get("displayName") || "").trim();
  const personId = String(formData.get("personId") || "").trim() || makePersonId(displayName);
  const baseWeight = Number(formData.get("baseWeight") || 1);
  const tags = parseTags(formData.get("tags"));
  const preferred = formData.get("preferred") === "on";
  const ignored = formData.get("ignored") === "on";
  const sampleNotes = String(formData.get("sampleNotes") || "").trim();
  const captureCount = state.camera.captures.length;
  const existingRecord = state.faces.find((item) => item.personId === personId);
  const minimumSamples = draftMode === DRAFT_MODES.create ? 3 : draftMode === DRAFT_MODES.append ? 1 : 0;

  if (!displayName) {
    setStatus("请填写姓名或显示名称。", "error");
    return;
  }

  if (draftMode === DRAFT_MODES.create && existingRecord) {
    setStatus("该编号已存在，请改用“修改”或“补录样本”。", "error");
    return;
  }

  if (captureCount < minimumSamples) {
    setStatus(
      minimumSamples === 1 ? "请至少补录 1 张新样本后再保存。" : "请至少采集 3 张样本后再保存。",
      "error"
    );
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

    await requestApi(draftMode === DRAFT_MODES.create ? "/api/admin/faces" : `/api/admin/faces/${encodeURIComponent(personId)}`, {
      method: draftMode === DRAFT_MODES.create ? "POST" : "PATCH",
      body: profilePayload
    });

    if (captureCount > 0) {
      await requestApi(`/api/admin/faces/${encodeURIComponent(personId)}/samples`, {
        method: "POST",
        body: uploadBody
      });
    }

    upsertLocalFace({
      ...(existingRecord || {}),
      ...profilePayload,
      descriptorCount: (existingRecord?.descriptorCount || 0) + captureCount,
      sampleCount: (existingRecord?.sampleCount || 0) + captureCount,
      updatedAt: new Date().toISOString()
    });

    stopCameraTracks();
    state.camera.enabled = false;
    resetDraft();
    state.loading = false;
    state.activeView = "roster";
    state.status = {
      tone: "success",
      message: draftMode === DRAFT_MODES.create
        ? `${displayName} 已录入完成。`
        : draftMode === DRAFT_MODES.append
          ? `${displayName} 的样本已补录。`
          : `${displayName} 的资料已更新。`
    };
    render();
    await refreshFaces();
    render();
  } catch (error) {
    upsertLocalFace({
      ...(existingRecord || {}),
      ...profilePayload,
      descriptorCount: (existingRecord?.descriptorCount || 0) + captureCount,
      sampleCount: (existingRecord?.sampleCount || 0) + captureCount,
      updatedAt: new Date().toISOString()
    });

    state.loading = false;
    setStatus(`服务器暂不可用，已保留本地预览：${error.message}`, "error");
  }
}

async function handleFaceDelete(personId) {
  const record = state.faces.find((item) => item.personId === personId);
  if (!record) {
    setStatus("未找到要删除的人脸记录。", "error");
    return;
  }

  const confirmed = window.confirm(`确定删除 ${record.displayName}（${record.personId}）吗？此操作会一并删除样本。`);
  if (!confirmed) {
    return;
  }

  setLoading(true);

  try {
    await requestApi(`/api/admin/faces/${encodeURIComponent(personId)}`, {
      method: "DELETE"
    });

    removeLocalFace(personId);

    if (state.draft.personId === personId) {
      stopCameraTracks();
      state.camera.enabled = false;
      resetDraft();
    }

    state.loading = false;
    setStatus(`${record.displayName} 已删除。`, "success");
    await refreshFaces();
    render();
  } catch (error) {
    state.loading = false;
    setStatus(`删除失败：${error.message}`, "error");
  }
}

async function handleDeviceSubmit(event) {
  event.preventDefault();

  const formData = new FormData(event.currentTarget);
  const deviceCode = String(formData.get("deviceCode") || "").trim();
  const classroom = String(formData.get("classroom") || "").trim();
  const packageVersion = String(formData.get("packageVersion") || "").trim();
  const devModeEnabled = formData.get("devModeEnabled") === "on";

  if (!deviceCode || !classroom) {
    setStatus("请填写完整的设备码和教室信息。", "error");
    return;
  }

  setLoading(true);

  try {
    const payloadBody = {
      deviceCode,
      classroom,
      devModeEnabled
    };

    if (packageVersion) {
      payloadBody.packageVersion = packageVersion;
    }

    const payload = await requestApi("/api/admin/devices/pair", {
      method: "POST",
      body: payloadBody
      });

      upsertLocalDevice(payload);
      state.deviceDraft = buildEmptyDeviceDraft();
      stopDeviceScannerTracks();
      state.deviceScanner.active = false;
      state.loading = false;
      setStatus(
        payload.packageVersion
        ? `设备 ${deviceCode} 已绑定到 ${classroom}，版本 ${payload.packageVersion} 已生效。`
        : `设备 ${deviceCode} 已绑定到 ${classroom}，暂未指定版本。`,
      "success"
    );
    await refreshDevices();
    render();
  } catch (error) {
    state.loading = false;
    if (error.code === "PACKAGE_NOT_FOUND") {
      setStatus("所选版本不存在。请先发布版本，或先留空绑定设备。", "error");
      return;
    }

    setStatus(`设备绑定失败：${error.message}`, "error");
  }
}

async function handleDeviceVersionSwitch(event) {
  event.preventDefault();

  const formData = new FormData(event.currentTarget);
  const deviceCode = String(formData.get("deviceCode") || "").trim();
  const packageVersion = String(formData.get("packageVersion") || "").trim();

  if (!deviceCode) {
    setStatus("未找到要更新的设备。", "error");
    return;
  }

  setLoading(true);

  try {
    const payloadBody = {};
    if (packageVersion) {
      payloadBody.packageVersion = packageVersion;
    }

    const payload = await requestApi(`/api/admin/devices/${encodeURIComponent(deviceCode)}/package`, {
      method: "PATCH",
      body: payloadBody
    });

    upsertLocalDevice(payload);
    state.loading = false;
    setStatus(
      packageVersion
        ? `设备 ${deviceCode} 已切换到版本 ${packageVersion}。`
        : `设备 ${deviceCode} 已清除指定版本。`,
      "success"
    );
    await refreshDevices();
    render();
  } catch (error) {
    state.loading = false;

    if (error.code === "PACKAGE_NOT_FOUND") {
      setStatus("所选版本不存在，请先发布该版本。", "error");
      return;
    }

    if (error.code === "DEVICE_NOT_PAIRED") {
      setStatus("该设备还没有绑定教室，先完成设备绑定。", "error");
      return;
    }

    setStatus(`版本切换失败：${error.message}`, "error");
  }
}

async function handlePublishSubmit(event) {
  event.preventDefault();

  const formData = new FormData(event.currentTarget);
  const version = String(formData.get("version") || "").trim() || suggestVersion();
  const notes = String(formData.get("notes") || "").trim();
  const groupId = String(formData.get("groupId") || "").trim();

  if (!groupId) {
    setStatus("请选择要批量发布的账号组。", "error");
    return;
  }

  setLoading(true);

  try {
    const payload = await requestApi("/api/admin/packages/publish", {
      method: "POST",
      body: { version, notes, groupId }
    });

    upsertLocalPackage({
      version: payload.version,
      isActive: true,
      notes,
      peopleCount: payload.peopleCount || state.faces.length,
      publishedAt: payload.publishedAt || new Date().toISOString(),
      operator: state.sessionEmail || "operator@example.com",
      groupId: payload.groupId || groupId,
      groupName: payload.groupName || ""
    });

    state.loading = false;
    setStatus(`已将版本 ${version} 发布到 ${payload.groupName || "所选账号组"}。`, "success");
    await refreshPackages();
    render();
  } catch (error) {
    state.loading = false;
    setStatus(`发布失败：${error.message}`, "error");
  }
}

async function handleGroupCreate(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const name = String(formData.get("name") || "").trim();
  const description = String(formData.get("description") || "").trim();
  if (!name) {
    setStatus("请填写账号组名称。", "error");
    return;
  }

  setLoading(true);
  try {
    await requestApi("/api/admin/groups", { method: "POST", body: { name, description } });
    await refreshGroups();
    state.loading = false;
    setStatus(`账号组 ${name} 已创建。`, "success");
  } catch (error) {
    state.loading = false;
    setStatus(`创建账号组失败：${error.message}`, "error");
  }
}

async function handleGroupSave(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const groupId = String(formData.get("groupId") || "");
  const body = {
    name: String(formData.get("name") || "").trim(),
    description: String(formData.get("description") || "").trim(),
    memberIds: formData.getAll("memberIds").map(String),
    deviceCodes: formData.getAll("deviceCodes").map(String)
  };

  setLoading(true);
  try {
    await requestApi(`/api/admin/groups/${encodeURIComponent(groupId)}`, { method: "PUT", body });
    await Promise.all([refreshGroups(), refreshFaces(), refreshDevices()]);
    state.loading = false;
    setStatus(`账号组 ${body.name} 的成员与设备分配已保存。`, "success");
  } catch (error) {
    state.loading = false;
    setStatus(`保存账号组失败：${error.message}`, "error");
  }
}

async function handleGroupDelete(groupId) {
  const group = state.groups.find((item) => item.id === groupId);
  if (!group || !window.confirm(`确定删除账号组“${group.name}”吗？成员和设备将变为未分组。`)) {
    return;
  }

  setLoading(true);
  try {
    await requestApi(`/api/admin/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    await refreshGroups();
    state.loading = false;
    setStatus(`账号组 ${group.name} 已删除。`, "success");
  } catch (error) {
    state.loading = false;
    setStatus(`删除账号组失败：${error.message}`, "error");
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

function renderAuthForm() {
  if (state.authMode === "register") {
    return `
      <form class="auth-form" data-register-form>
        <div class="auth-heading"><span class="eyebrow">创建账号</span><h1>建立你的点名空间</h1><p>注册前必须先通过 Cloudflare 人机验证，密码至少 8 位。</p></div>
        <label class="field"><span>邮箱</span><input name="email" type="email" autocomplete="email" placeholder="仅支持 Gmail、Outlook、QQ、163、126、Foxmail 等公共邮箱" required /><small>企业域名邮箱及 Proton 邮箱不可注册。</small></label>
        <label class="field"><span>密码</span><input name="password" type="password" autocomplete="new-password" minlength="8" required /></label>
        <label class="field"><span>确认密码</span><input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required /></label>
        ${renderRegistrationGuard()}
        <button class="primary-button auth-submit" type="submit" ${state.registrationGuard.loading || !isRegisterProtectionReady() ? "disabled" : ""}>创建账号</button>
        <button class="text-button" type="button" data-auth-mode="login">已有账号，返回登录</button>
      </form>`;
  }

  if (state.authMode === "verify") {
    return `
      <form class="auth-form" data-verify-form>
        <div class="auth-heading"><span class="eyebrow">邮箱验证</span><h1>确认你的邮箱</h1><p>输入发送到邮箱的验证码。</p></div>
        <label class="field"><span>邮箱</span><input name="email" type="email" value="${escapeHtml(state.authContext.email)}" required /></label>
        <label class="field"><span>验证码</span><input name="code" inputmode="numeric" autocomplete="one-time-code" value="${escapeHtml(state.authContext.verificationCode)}" required /></label>
        ${state.authContext.verificationCode ? `<div class="dev-notice">当前服务尚未接入邮件发送，验证码已自动填入。</div>` : ""}
        <button class="primary-button auth-submit" type="submit">完成验证</button>
        <button class="text-button" type="button" data-auth-mode="login">稍后验证</button>
      </form>`;
  }

  if (state.authMode === "forgot") {
    return `
      <form class="auth-form" data-forgot-form>
        <div class="auth-heading"><span class="eyebrow">找回密码</span><h1>重新获得账号访问权</h1><p>提交注册邮箱，获取密码重置凭据。</p></div>
        <label class="field"><span>邮箱</span><input name="email" type="email" autocomplete="email" required /></label>
        <button class="primary-button auth-submit" type="submit">继续</button>
        <button class="text-button" type="button" data-auth-mode="login">返回登录</button>
      </form>`;
  }

  if (state.authMode === "reset") {
    return `
      <form class="auth-form" data-reset-form>
        <div class="auth-heading"><span class="eyebrow">设置新密码</span><h1>更新登录密码</h1><p>新密码至少 8 位，设置后原密码立即失效。</p></div>
        <label class="field"><span>重置凭据</span><input name="token" value="${escapeHtml(state.authContext.resetToken)}" required /></label>
        <label class="field"><span>新密码</span><input name="password" type="password" autocomplete="new-password" minlength="8" required /></label>
        <label class="field"><span>确认新密码</span><input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required /></label>
        ${state.authContext.resetToken ? `<div class="dev-notice">当前服务尚未接入邮件发送，重置凭据已自动填入。</div>` : ""}
        <button class="primary-button auth-submit" type="submit">重置密码</button>
        <button class="text-button" type="button" data-auth-mode="login">取消</button>
      </form>`;
  }

  return `
    <form class="auth-form" data-login-form>
      <div class="auth-heading"><span class="eyebrow">Smart Roll Call</span><h1>欢迎回来</h1><p>登录后管理人脸名册、教室设备和发布版本。</p></div>
      <label class="field"><span>邮箱</span><input name="email" type="email" autocomplete="email" value="${escapeHtml(state.authContext.email)}" required /></label>
      <label class="field"><span>密码</span><input name="password" type="password" autocomplete="current-password" minlength="8" required /></label>
      <div class="auth-form-row"><label class="remember-copy"><input type="checkbox" checked disabled /> 在此设备保持登录</label><button class="text-button" type="button" data-auth-mode="forgot">忘记密码？</button></div>
      <button class="primary-button auth-submit" type="submit">登录</button>
      <button class="text-button" type="button" data-auth-mode="register">没有账号？立即注册</button>
    </form>`;
}

function renderAuthScreen() {
  return `
    <main class="auth-page">
      <section class="auth-story">
        <span class="eyebrow">人脸点名管理</span>
        <h2>一次录入，稳定同步到每一台教室设备。</h2>
        <p>账号用于保护人脸名册和发布权限。所有业务操作都需要登录后进行。</p>
        <div class="auth-steps"><span>实时采集</span><span>名册管理</span><span>设备同步</span></div>
      </section>
      <section class="auth-card">
        ${state.loading ? `<div class="loading-banner">正在处理，请稍候…</div>` : ""}
        ${renderAuthForm()}
        <div class="status ${state.status.tone}">${escapeHtml(state.status.message)}</div>
        <form class="auth-server" data-settings-form>
          <label class="field"><span>服务地址</span><input name="apiBaseUrl" value="${escapeHtml(state.apiBaseUrl)}" /></label>
          <button class="ghost-button compact" type="submit">保存</button>
        </form>
      </section>
    </main>`;
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
        ${NAV_ITEMS.filter((item) => !item.adminOnly || state.account?.role === "admin").map((item) => `
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
            <button class="ghost-button compact" type="button" data-edit-face="${escapeHtml(face.personId)}">修改资料</button>
          </article>
        `).join("") || `<div class="empty-card">还没有录入任何成员，先去“录入人脸”页打开摄像头。</div>`}
      </div>
    </section>
  `;
}

function renderEnroll() {
  const captureCount = state.camera.captures.length;
  const draftConfig = getDraftConfig();

  return `
    <section class="panel enroll-layout">
      <div class="camera-shell">
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">实时取景</div>
            <h2>${escapeHtml(draftConfig.cameraTitle)}</h2>
            <p class="subcopy">${escapeHtml(draftConfig.cameraCopy)}</p>
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
            <div class="camera-tip">${state.camera.enabled ? escapeHtml(draftConfig.activeCameraTip) : escapeHtml(draftConfig.idleCameraTip)}</div>
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
            <div class="section-kicker">${escapeHtml(draftConfig.formKicker)}</div>
            <h2>${escapeHtml(draftConfig.formTitle)}</h2>
            <p class="subcopy">${escapeHtml(draftConfig.formCopy)}</p>
          </div>
        </div>
        <div class="form-grid">
          <label class="field">
            <span>姓名</span>
            <input name="displayName" type="text" value="${escapeHtml(state.draft.displayName)}" placeholder="例如：张三" required />
          </label>
          <label class="field">
            <span>编号</span>
            <input class="${draftConfig.personIdReadonly ? "readonly-input" : ""}" name="personId" type="text" value="${escapeHtml(state.draft.personId)}" placeholder="可留空自动生成" ${draftConfig.personIdReadonly ? "readonly" : ""} />
            ${draftConfig.personIdReadonly ? '<small class="field-hint">已有成员的编号不可修改。</small>' : ""}
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
        <div class="notice-card">${escapeHtml(draftConfig.notice)}</div>
        <div class="inline-actions">
          <button class="primary-button" type="submit">${escapeHtml(draftConfig.submitLabel)}</button>
          <button class="ghost-button" type="button" data-reset-draft>${escapeHtml(draftConfig.resetLabel)}</button>
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
          <h2>查看、修改和删除成员</h2>
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
              ${state.account?.role === "admin" ? `<p class="card-copy">归属账号：${escapeHtml(face.ownerEmail || "历史未归属")}</p>` : ""}
              <p class="card-copy">${escapeHtml(face.tags.join(" / ") || "未设置标签")}</p>
            <div class="card-footer">
              <span>更新于 ${escapeHtml(formatDate(face.updatedAt))}</span>
              <div class="inline-actions tight-actions">
                <button class="ghost-button compact" type="button" data-append-face="${escapeHtml(face.personId)}">补录样本</button>
                <button class="ghost-button compact" type="button" data-edit-face="${escapeHtml(face.personId)}">修改</button>
                <button class="ghost-button compact danger-button" type="button" data-delete-face="${escapeHtml(face.personId)}">删除</button>
              </div>
            </div>
          </article>
        `).join("") || `<div class="empty-card">${state.searchQuery ? "没有匹配到结果。" : "名册还是空的，先去“录入人脸”页采集第一位成员。"}</div>`}
      </div>
    </section>
  `;
}

function renderDevices() {
  const canManageDevices = state.account?.role === "admin";
  const joinedGroupNames = formatGroupNames(state.account?.groups);
  return `
    <section class="panel panel-split">
      ${canManageDevices ? `<form class="form-panel" data-device-form>
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
          <div class="switch-row">
            <label><input name="devModeEnabled" type="checkbox" /> 调试可视化</label>
          </div>
        </div>
        <div class="notice-card">
          这里先完成设备与教室的绑定。版本切换在右侧设备卡片里单独处理，不需要重新绑定。
        </div>
        <div class="inline-actions">
          <button class="primary-button" type="submit">保存设备</button>
        </div>
      </form>` : `<section class="form-panel"><div class="section-kicker">组内设备</div><h2>${escapeHtml(state.account?.group?.name || "尚未加入账号组")}</h2><div class="notice-card">这里只显示管理员分配给当前账号组的设备。你录入的人脸不会对其他组员可见，管理员发布组版本后设备会自动更新。</div></section>`}

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
              <div class="device-meta">当前版本：${escapeHtml(device.packageVersion || "未指定")}</div>
              <div class="device-meta">绑定时间：${escapeHtml(formatDate(device.pairedAt))}</div>
              <div class="device-meta">最近同步：${escapeHtml(formatDate(device.lastSeenAt))}</div>
              ${canManageDevices ? `<form class="inline-form" data-device-version-form>
                <input name="deviceCode" type="hidden" value="${escapeHtml(device.deviceCode)}" />
                <select name="packageVersion">
                  ${renderPackageOptions(device.packageVersion, "清除指定版本")}
                </select>
                <button class="ghost-button compact" type="submit">切换版本</button>
              </form>` : ""}
            </article>
          `).join("") || `<div class="empty-card">还没有绑定任何设备，等录入完成并发布版本后再来这里绑定。</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderGroups() {
  return `
    <section class="panel panel-split">
      <form class="form-panel" data-group-create-form>
        <div class="panel-heading compact-head"><div><div class="section-kicker">新建账号组</div><h2>组织成员与设备</h2></div></div>
        <div class="form-grid">
          <label class="field"><span>组名称</span><input name="name" maxlength="80" placeholder="例如：一年级一班" required /></label>
          <label class="field field-wide"><span>说明</span><textarea name="description" maxlength="300" placeholder="选填，用于说明用途或负责人"></textarea></label>
        </div>
        <div class="inline-actions"><button class="primary-button" type="submit">创建账号组</button></div>
      </form>
      <section class="form-panel">
        <div class="section-kicker">分配规则</div><h2>组内隔离</h2>
        <div class="notice-card">每个账号和设备只能属于一个组。成员只能看到自己的脸和本组设备；管理员可查看组内全部成员数据并批量发布。</div>
        <div class="account-facts"><span>账号组</span><strong>${state.groups.length}</strong><span>可分配账号</span><strong>${state.groupUsers.length}</strong><span>可分配设备</span><strong>${state.groupDevices.length}</strong></div>
      </section>
    </section>
    <section class="group-grid">
      ${state.groups.map((group) => `
        <form class="panel group-card" data-group-form>
          <input type="hidden" name="groupId" value="${escapeHtml(group.id)}" />
          <div class="panel-heading compact-head"><div><div class="section-kicker">账号组</div><h2>${escapeHtml(group.name)}</h2></div><button class="ghost-button compact danger-button" type="button" data-delete-group="${escapeHtml(group.id)}">删除</button></div>
          <div class="form-grid">
            <label class="field"><span>组名称</span><input name="name" value="${escapeHtml(group.name)}" required /></label>
            <label class="field"><span>说明</span><input name="description" value="${escapeHtml(group.description || "")}" /></label>
          </div>
          <h3 class="selection-title">成员</h3>
          <div class="selection-grid">
            ${state.groupUsers.map((user) => `<label class="selection-item"><input type="checkbox" name="memberIds" value="${escapeHtml(user.id)}" ${user.groupId === group.id ? "checked" : ""} /><span>${escapeHtml(user.email)}<small>${user.groupId && user.groupId !== group.id ? "已在其他组" : user.role}</small></span></label>`).join("") || `<div class="empty-card">暂无可分配账号</div>`}
          </div>
          <h3 class="selection-title">设备</h3>
          <div class="selection-grid">
            ${state.groupDevices.map((device) => `<label class="selection-item"><input type="checkbox" name="deviceCodes" value="${escapeHtml(device.deviceCode)}" ${device.groupId === group.id ? "checked" : ""} /><span>${escapeHtml(device.classroom || device.deviceCode)}<small>${escapeHtml(device.deviceCode)}${device.groupId && device.groupId !== group.id ? " · 已在其他组" : ""}</small></span></label>`).join("") || `<div class="empty-card">暂无已登记设备</div>`}
          </div>
          <div class="inline-actions"><button class="primary-button" type="submit">保存成员与设备</button></div>
        </form>
      `).join("") || `<div class="empty-card">还没有账号组，请先创建。</div>`}
    </section>
  `;
}

function renderDevicesView() {
  const canManageDevices = state.account?.role === "admin";
  const joinedGroupNames = formatGroupNames(state.account?.groups);

  return `
    <section class="panel panel-split">
      ${canManageDevices ? `<form class="form-panel" data-device-form>
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">设备绑定</div>
            <h2>把设备连到教室</h2>
          </div>
        </div>
        <div class="form-grid">
          <label class="field">
            <span>设备码</span>
            <input name="deviceCode" data-device-draft="deviceCode" type="text" value="${escapeHtml(state.deviceDraft.deviceCode)}" placeholder="从终端复制或扫码录入设备码" required />
          </label>
          <label class="field">
            <span>教室或班级</span>
            <input name="classroom" data-device-draft="classroom" type="text" value="${escapeHtml(state.deviceDraft.classroom)}" placeholder="例如：Room 301 / 一年级一班" required />
          </label>
          <div class="switch-row">
            <label><input name="devModeEnabled" data-device-draft="devModeEnabled" type="checkbox" ${state.deviceDraft.devModeEnabled ? "checked" : ""} /> 调试可视化</label>
          </div>
        </div>
        <div class="device-scan-panel">
          <div class="device-scan-stage">
            ${state.deviceScanner.active
              ? `<video class="device-scanner-preview" data-device-scanner-preview></video><div class="camera-overlay"><div class="scan-frame scan-frame-wide"></div><div class="scan-line"></div><div class="camera-tip">将设备码放入框内，识别后自动填入</div></div>`
              : `<div class="scan-placeholder"><strong>后置摄像头扫码</strong><p>识别二维码或条码后，会自动填入上方设备码输入框。</p></div>`}
          </div>
          <div class="inline-actions">
            ${state.deviceScanner.active
              ? `<button class="ghost-button" type="button" data-stop-device-scan>停止扫码</button>`
              : `<button class="ghost-button" type="button" data-start-device-scan>打开扫码</button>`}
          </div>
          ${state.deviceScanner.lastDetectedCode ? `<div class="notice-card">最近识别：<span class="mono">${escapeHtml(state.deviceScanner.lastDetectedCode)}</span></div>` : ""}
          ${state.deviceScanner.supported === false ? `<div class="notice-card notice-card-danger">${escapeHtml(state.deviceScanner.error || "当前浏览器不支持自动扫码，请手动输入设备码。")}</div>` : ""}
        </div>
        <div class="notice-card">
          先完成设备与教室的绑定。版本切换仍可在右侧设备卡片里单独处理，不需要重新绑定。
        </div>
        <div class="inline-actions">
          <button class="primary-button" type="submit">保存设备</button>
        </div>
      </form>` : `<section class="form-panel"><div class="section-kicker">组内设备</div><h2>${escapeHtml(joinedGroupNames)}</h2><div class="notice-card">这里只显示管理员分配给当前账号所在账号组的设备。你录入的人脸不会对其他组员可见，管理员发布组版本后设备会自动更新。</div></section>`}

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
              <div class="device-meta">当前版本：${escapeHtml(device.packageVersion || "未指定")}</div>
              <div class="device-meta">绑定时间：${escapeHtml(formatDate(device.pairedAt))}</div>
              <div class="device-meta">最近同步：${escapeHtml(formatDate(device.lastSeenAt))}</div>
              ${canManageDevices ? `<form class="inline-form" data-device-version-form>
                <input name="deviceCode" type="hidden" value="${escapeHtml(device.deviceCode)}" />
                <select name="packageVersion">
                  ${renderPackageOptions(device.packageVersion, "清除指定版本")}
                </select>
                <button class="ghost-button compact" type="submit">切换版本</button>
              </form>` : ""}
            </article>
          `).join("") || `<div class="empty-card">还没有绑定任何设备，等录入完成并发布版本后再来这里绑定。</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderGroupsView() {
  return `
    <section class="panel panel-split">
      <form class="form-panel" data-group-create-form>
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">新建账号组</div>
            <h2>组织成员与设备</h2>
          </div>
        </div>
        <div class="form-grid">
          <label class="field">
            <span>组名称</span>
            <input name="name" maxlength="80" placeholder="例如：一年级一班" required />
          </label>
          <label class="field field-wide">
            <span>说明</span>
            <textarea name="description" maxlength="300" placeholder="选填，用于说明用途或负责人"></textarea>
          </label>
        </div>
        <div class="inline-actions"><button class="primary-button" type="submit">创建账号组</button></div>
      </form>
      <section class="form-panel">
        <div class="section-kicker">分配规则</div>
        <h2>组内隔离</h2>
        <div class="notice-card">设备仍然只属于一个账号组。普通成员仍只属于一个组，保存到新组时会自动从旧组迁出；管理员可以同时加入多个组。</div>
        <div class="account-facts"><span>账号组</span><strong>${state.groups.length}</strong><span>可分配账号</span><strong>${state.groupUsers.length}</strong><span>可分配设备</span><strong>${state.groupDevices.length}</strong></div>
      </section>
    </section>
    <section class="group-grid">
      ${state.groups.map((group) => `
        <form class="panel group-card" data-group-form>
          <input type="hidden" name="groupId" value="${escapeHtml(group.id)}" />
          <div class="panel-heading compact-head">
            <div>
              <div class="section-kicker">账号组</div>
              <h2>${escapeHtml(group.name)}</h2>
            </div>
            <button class="ghost-button compact danger-button" type="button" data-delete-group="${escapeHtml(group.id)}">删除</button>
          </div>
          <div class="form-grid">
            <label class="field"><span>组名称</span><input name="name" value="${escapeHtml(group.name)}" required /></label>
            <label class="field"><span>说明</span><input name="description" value="${escapeHtml(group.description || "")}" /></label>
          </div>
          <h3 class="selection-title">成员</h3>
          <div class="selection-grid">
            ${state.groupUsers.map((user) => {
              const groupIds = Array.isArray(user.groupIds) ? user.groupIds : [];
              const otherGroupIds = groupIds.filter((item) => item !== group.id);
              const helperText = user.role === "admin"
                ? `管理员${otherGroupIds.length > 0 ? "，可同时保留其他组权限" : "，可加入多个组"}`
                : otherGroupIds.length > 0
                  ? "成员，保存后将从其他组迁移到当前组"
                  : user.role;

              return `<label class="selection-item"><input type="checkbox" name="memberIds" value="${escapeHtml(user.id)}" ${groupIds.includes(group.id) ? "checked" : ""} /><span>${escapeHtml(user.email)}<small>${escapeHtml(helperText)}</small></span></label>`;
            }).join("") || `<div class="empty-card">暂无可分配账号</div>`}
          </div>
          <h3 class="selection-title">设备</h3>
          <div class="selection-grid">
            ${state.groupDevices.map((device) => `<label class="selection-item"><input type="checkbox" name="deviceCodes" value="${escapeHtml(device.deviceCode)}" ${device.groupId === group.id ? "checked" : ""} /><span>${escapeHtml(device.classroom || device.deviceCode)}<small>${escapeHtml(device.deviceCode)}${device.groupId && device.groupId !== group.id ? " / 当前在其他组" : ""}</small></span></label>`).join("") || `<div class="empty-card">暂无已登记设备</div>`}
          </div>
          <div class="inline-actions"><button class="primary-button" type="submit">保存成员与设备</button></div>
        </form>
      `).join("") || `<div class="empty-card">还没有账号组，请先创建。</div>`}
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
            <span>目标账号组</span>
            <select name="groupId" required><option value="">请选择账号组</option>${state.groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}（${group.members.length} 人 / ${group.devices.length} 台设备）</option>`).join("")}</select>
          </label>
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
              <span>${escapeHtml(pkg.groupName || "历史全局版本")}</span>
              <span>${escapeHtml(formatDate(pkg.publishedAt))}</span>
              <span>${escapeHtml(pkg.operator || "未知操作人")}</span>
              <span>${pkg.isActive ? "当前使用中" : "历史版本"}</span>
            </div>
          </article>
        `).join("") || `<div class="empty-card">还没有任何发布版本。完成录入后即可发布第一版。</div>`}
      </div>
    </section>
  `;
}

function renderSettings() {
  const roleLabel = state.account?.role === "admin" ? "管理员" : "组成员";
  return `
    <section class="panel panel-split">
      <section class="form-panel">
        <div class="panel-heading compact-head">
          <div>
            <div class="section-kicker">账号中心</div>
            <h2>登录与权限</h2>
          </div>
          <button class="ghost-button" type="button" data-logout>退出登录</button>
        </div>
        <div class="account-summary">
          <div class="account-avatar">${escapeHtml((state.sessionEmail || "A").slice(0, 1).toUpperCase())}</div>
          <div><strong>${escapeHtml(state.sessionEmail)}</strong><p>${roleLabel} · 邮箱已验证</p></div>
        </div>
        <div class="account-facts">
          <span>账号创建时间</span><strong>${escapeHtml(formatDate(state.account?.createdAt))}</strong>
          <span>账号权限</span><strong>${roleLabel}</strong>
        </div>
      </section>

      <form class="form-panel" data-change-password-form>
        <div class="panel-heading compact-head"><div><div class="section-kicker">安全</div><h2>修改密码</h2></div></div>
        <div class="form-grid">
          <label class="field field-wide"><span>当前密码</span><input name="currentPassword" type="password" autocomplete="current-password" required /></label>
          <label class="field"><span>新密码</span><input name="newPassword" type="password" autocomplete="new-password" minlength="8" required /></label>
          <label class="field"><span>确认新密码</span><input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required /></label>
        </div>
        <div class="inline-actions"><button class="primary-button" type="submit">更新密码</button></div>
      </form>
    </section>

    <section class="panel">
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
            <input name="apiBaseUrl" type="text" value="${escapeHtml(state.apiBaseUrl)}" placeholder="${escapeHtml(getDefaultApiBaseUrl())}" />
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
      return renderDevicesView();
    case "groups":
      return state.account?.role === "admin" ? renderGroupsView() : renderHome();
    case "publish":
      return renderPublish();
    case "settings":
      return renderSettings();
    default:
      return renderHome();
  }
}

function render() {
  resetTurnstileState();

  if (!isLoggedIn()) {
    app.innerHTML = renderAuthScreen();
    bindEvents();
    void ensureRegisterProtection();
    return;
  }

  app.innerHTML = `
    ${renderTopbar()}
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
  attachDeviceScannerStream();
}

function bindEvents() {
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      resetTurnstileState();
      state.authMode = button.dataset.authMode;
      state.status = { tone: "neutral", message: "请填写账号信息。" };
      render();
    });
  });

  document.querySelectorAll("[data-nav-view]").forEach((button) => {
    button.addEventListener("click", () => {
      switchView(button.dataset.navView);
    });
  });

  document.querySelectorAll("[data-quick-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.quickView === "enroll") {
        openEnrollDraft(null, DRAFT_MODES.create);
        return;
      }

      switchView(button.dataset.quickView);
    });
  });

  document.querySelector("[data-settings-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    state.apiBaseUrl = normalizeApiBaseUrl(formData.get("apiBaseUrl"));
    persistSession();
    state.registrationGuard.configLoadedForApiBaseUrl = "";
    state.registrationGuard.loadError = "";
    state.registrationGuard.captchaEnabled = false;
    state.registrationGuard.turnstileSiteKey = "";
    state.registrationGuard.registrationLimitPerIp = 2;
    resetTurnstileState();
    setStatus(`已切换服务地址到 ${state.apiBaseUrl}。`, "success");
    if (!isLoggedIn()) {
      void loadRegisterConfig({ force: true, silent: false });
    }
  });

  document.querySelector("[data-login-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await login(
      String(formData.get("email") || "").trim(),
      String(formData.get("password") || "").trim()
    );
  });

  document.querySelector("[data-register-form]")?.addEventListener("submit", handleRegister);
  document.querySelector("[data-verify-form]")?.addEventListener("submit", handleVerify);
  document.querySelector("[data-forgot-form]")?.addEventListener("submit", handleForgotPassword);
  document.querySelector("[data-reset-form]")?.addEventListener("submit", handleResetPassword);
  document.querySelector("[data-change-password-form]")?.addEventListener("submit", handleChangePassword);

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
    const shouldReturnToRoster = state.draft.mode !== DRAFT_MODES.create;
    resetDraft();
    if (shouldReturnToRoster) {
      state.activeView = "roster";
    }
    render();
  });

  document.querySelector("[data-enroll-form]")?.addEventListener("submit", handleEnrollSubmit);
  document.querySelector("[data-device-form]")?.addEventListener("submit", handleDeviceSubmit);
  document.querySelectorAll("[data-device-draft]").forEach((field) => {
    const eventName = field.type === "checkbox" ? "change" : "input";
    field.addEventListener(eventName, (event) => {
      updateDeviceDraftField(
        field.dataset.deviceDraft,
        field.type === "checkbox" ? event.currentTarget.checked : event.currentTarget.value
      );
    });
  });
  document.querySelector("[data-start-device-scan]")?.addEventListener("click", () => {
    startDeviceScanner();
  });
  document.querySelector("[data-stop-device-scan]")?.addEventListener("click", stopDeviceScanner);
  document.querySelectorAll("[data-device-version-form]").forEach((form) => {
    form.addEventListener("submit", handleDeviceVersionSwitch);
  });
  document.querySelector("[data-publish-form]")?.addEventListener("submit", handlePublishSubmit);
  document.querySelector("[data-rollback-form]")?.addEventListener("submit", handleRollbackSubmit);
  document.querySelector("[data-group-create-form]")?.addEventListener("submit", handleGroupCreate);
  document.querySelectorAll("[data-group-form]").forEach((form) => {
    form.addEventListener("submit", handleGroupSave);
  });
  document.querySelectorAll("[data-delete-group]").forEach((button) => {
    button.addEventListener("click", () => handleGroupDelete(button.dataset.deleteGroup));
  });

  document.querySelector("[data-search-input]")?.addEventListener("input", (event) => {
    state.searchQuery = event.currentTarget.value;
    render();
  });

  document.querySelectorAll("[data-edit-face]").forEach((button) => {
    button.addEventListener("click", () => {
      const record = state.faces.find((item) => item.personId === button.dataset.editFace);
      openEnrollDraft(record || null, DRAFT_MODES.edit);
    });
  });

  document.querySelectorAll("[data-append-face]").forEach((button) => {
    button.addEventListener("click", () => {
      const record = state.faces.find((item) => item.personId === button.dataset.appendFace);
      openEnrollDraft(record || null, DRAFT_MODES.append);
    });
  });

  document.querySelectorAll("[data-delete-face]").forEach((button) => {
    button.addEventListener("click", () => {
      handleFaceDelete(button.dataset.deleteFace);
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
    try {
      await loadAccount();
      await refreshAll({ silent: false });
    } catch (error) {
      state.loading = false;
      setStatus(`登录状态已失效：${error.message}`, "error");
    }
  }
}

window.addEventListener("beforeunload", () => {
  stopCameraTracks();
  stopDeviceScannerTracks();
  revokeCaptureUrls();
});

init();
