<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
	Document,
	Folder,
	FolderOpened,
	Plus,
	Search,
	Star,
	StarFilled,
	Delete,
	Setting,
	UploadFilled,
	Paperclip,
	MoreFilled,
	Share,
	Check,
	Refresh,
	Download,
	Lock,
	ArrowRight,
	SwitchButton,
	EditPen,
	CopyDocument,
	Menu,
	ArrowLeft,
	Clock,
	FullScreen,
	Aim,
	Operation,
	ArrowUp,
	ArrowDown,
	Fold,
	Expand,
	Moon,
	Sunny,
} from "@element-plus/icons-vue";
import { MdEditor, MdPreview } from "md-editor-v3";
import { sanitizeMarkdown as sanitize } from "../utils/sanitize.js";
import { api, uploadFile } from "../api/client.js";
import { createSaveQueue } from "../utils/save-queue.js";
import { extractAttachments } from "../utils/attachments.js";
import { createUploadId } from "../utils/browser-compat.js";
import ShareManagement from "../components/ShareManagement.vue";
import ContextMenu from "../components/ContextMenu.vue";
import { submitFormOnEnter } from "../utils/form-submit.js";
import { themePreference, isDark, editorTheme, toggleTheme } from "../stores/theme.js";
import logoUrl from "../assets/logo.js";
const ready = ref(false),
	booting = ref(true),
	initialized = ref(true),
	password = ref(""),
	loginBusy = ref(false),
	error = ref("");
const confirmPassword = ref(""),
	passwordForm = ref({ current: "", next: "", confirm: "" }),
	passwordBusy = ref(false),
	passwordDialog = ref(false),
	passwordError = ref("");
const isMobile = ref(window.matchMedia("(max-width:800px)").matches),
	mobilePane = ref("list"),
	navOpen = ref(false),
	viewportHeight = ref(window.visualViewport?.height || window.innerHeight),
	offline = ref(!navigator.onLine);
const deviceQuery = window.matchMedia("(max-width:800px)");
const sidebarCollapsed = ref(localStorage.getItem("notespace:sidebar-collapsed") === "true");
watch(sidebarCollapsed, (collapsed) => {
	localStorage.setItem("notespace:sidebar-collapsed", String(collapsed));
});
function deviceChange() {
	isMobile.value = deviceQuery.matches;
	viewportHeight.value = window.visualViewport?.height || window.innerHeight;
	document.documentElement.style.setProperty("--app-height", viewportHeight.value + "px");
}
watch(isMobile, (mobile) => {
	navOpen.value = false;
	if (mobile && mode.value === "split") mode.value = "edit";
});
let previousNavFocus;
watch(navOpen, async (open) => {
	if (!isMobile.value) return;
	if (open) {
		previousNavFocus = document.activeElement;
		await nextTick();
		document.querySelector(".mobile-nav-close")?.focus();
	} else {
		await nextTick();
		if (previousNavFocus?.isConnected && !document.activeElement?.closest(".el-dialog")) previousNavFocus.focus();
	}
});
function readListPreferences() {
	try {
		return JSON.parse(localStorage.getItem("notespace:list-options") || "{}");
	} catch {
		return {};
	}
}
const listPreferences = readListPreferences() || {};
const sortOptions = [
	{ key: "created", label: "创建时间" },
	{ key: "updated", label: "修改时间" },
	{ key: "name", label: "文件名称" },
	{ key: "size", label: "文件大小" },
];
const sortDirection = ref(listPreferences.direction === "asc" ? "asc" : "desc");
const listView = ref(listPreferences.view === "comfortable" ? "comfortable" : "compact");
const showListDates = ref(listPreferences.showDates !== false);
const listOptionsOpen = ref(false),
	searchInput = ref(null);
const state = ref({
		entries: [],
		favorites: [],
		trash: [],
		shares: [],
		attachments: [],
	}),
	section = ref("all"),
	folder = ref(""),
	query = ref(""),
	sort = ref(sortOptions.some((option) => option.key === listPreferences.sort) ? listPreferences.sort : "updated"),
	selected = ref(null),
	title = ref(""),
	content = ref(""),
	editor = ref(null),
	editorSession = ref(0),
	saveStatus = ref("已保存"),
	mode = ref("split"),
	focusMode = ref(false);
watch([sort, sortDirection, listView, showListDates], () => {
	try {
		localStorage.setItem("notespace:list-options", JSON.stringify({ sort: sort.value, direction: sortDirection.value, view: listView.value, showDates: showListDates.value }));
	} catch {
		/* List preferences are optional when browser storage is unavailable. */
	}
});
const sortLabel = computed(() => sortOptions.find((option) => option.key === sort.value)?.label || "修改时间");
function selectListOption(command) {
	if (command.startsWith("view:")) listView.value = command.slice(5);
	else if (command.startsWith("sort:")) {
		const key = command.slice(5);
		if (key === sort.value) sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
		else {
			sort.value = key;
			sortDirection.value = key === "name" ? "asc" : "desc";
		}
	} else if (command === "dates") showListDates.value = !showListDates.value;
	listOptionsOpen.value = false;
}
// MdEditor uses `preview` only during initialization. Control its internal
// layout explicitly, including when the editor mounts again after reading mode.
watch(
	[mode, editor],
	async ([value, instance]) => {
		await nextTick();
		if (instance && instance === editor.value && value === mode.value) instance.togglePreview(value === "split");
	},
	{ flush: "post" },
);
const settings = ref(false),
	shareManagementOpen = ref(false),
	attachmentDialog = ref(false),
	shareDialog = ref(false),
	sharePassword = ref(""),
	shareHours = ref(24),
	shareLink = ref(""),
	shareBusy = ref(false),
	jobs = ref([]),
	backupBusy = ref(false);
const shareExpiryOptions = [
	{ label: "长期", hours: 0 },
	{ label: "3 天", hours: 72 },
	{ label: "7 天", hours: 168 },
	{ label: "1 个月", hours: 720 },
];
const itemDialog = ref(false),
	itemBusy = ref(false),
	itemForm = ref({ kind: "note", name: "", parent: "", from: "" });
const lockView = ref(null),
	lockPath = ref(""),
	unlockPath = ref(""),
	lockPassword = ref(""),
	unlockBusy = ref(false),
	unlockError = ref("");
const lockDialog = ref(false),
	lockTarget = ref(""),
	lockForm = ref({ current: "", login: "", password: "", confirm: "" }),
	readingReset = ref(false),
	readingError = ref(""),
	lockBusy = ref(false);
const historyDialog = ref(false),
	history = ref([]),
	historyPreview = ref(null),
	historyBusy = ref(false);
const loadingNavigation = ref(0);
const selectedTrash = ref(null);
const checkedTrashIds = ref([]), trashBatchBusy = ref(false), trashBatchError = ref("");
const allTrashChecked = computed(() => state.value.trash.length > 0 && state.value.trash.every((item) => checkedTrashIds.value.includes(item.id)));
const someTrashChecked = computed(() => checkedTrashIds.value.length > 0 && !allTrashChecked.value);
watch(() => state.value.trash, (items) => {
	const ids = new Set(items.map((item) => item.id));
	checkedTrashIds.value = checkedTrashIds.value.filter((id) => ids.has(id));
});
watch(section, () => { checkedTrashIds.value = []; trashBatchError.value = ""; });
function selectAllTrash(checked) {
	checkedTrashIds.value = checked ? state.value.trash.map((item) => item.id) : [];
}
function selectTrash(id, checked) {
	checkedTrashIds.value = checked ? [...new Set([...checkedTrashIds.value, id])] : checkedTrashIds.value.filter((value) => value !== id);
}
let pendingUnlock,
	navigationVersion = 0;
const folderUnlock = computed(() => lockView.value?.type === "folder");
function requestUnlock(path, target) {
	if (pendingUnlock) return pendingUnlock.promise;
	lockPath.value = path;
	const selectedScope = selected.value && inScope(selected.value.path, path);
	unlockPath.value = target?.path || (selectedScope ? selected.value.path : path);
	lockPassword.value = "";
	unlockError.value = "";
	navOpen.value = false;
	lockView.value = target || {
		path: selectedScope ? selected.value.path : path,
		type: selectedScope ? "note" : "resource",
	};
	historyDialog.value = false;
	attachmentDialog.value = false;
	shareDialog.value = false;
	settings.value = false;
	itemDialog.value = false;
	if (isMobile.value) mobilePane.value = folderUnlock.value ? "list" : "editor";
	let resolve, reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	pendingUnlock = { promise, resolve, reject };
	return promise;
}
function cancelUnlock() {
	pendingUnlock?.reject("cancel");
	pendingUnlock = null;
	lockView.value = null;
}
async function submitUnlock() {
	const pending = pendingUnlock;
	if (!pending || unlockBusy.value) return;
	unlockBusy.value = true;
	try {
		await api("/locks/unlock", "POST", {
			path: unlockPath.value,
			password: lockPassword.value,
		});
		if (pendingUnlock !== pending) return;
		const done = pendingUnlock;
		pendingUnlock = null;
		lockPassword.value = "";
		lockView.value = null;
		done?.resolve();
	} catch (e) {
		if (pendingUnlock === pending) unlockError.value = e.message;
	} finally {
		unlockBusy.value = false;
	}
}
async function withAccess(fn, target) {
	for (let attempts = 0; attempts < 32; attempts++) {
		try {
			if (target?.navigation !== undefined && target.navigation !== navigationVersion) throw "cancel";
			return await fn();
		} catch (e) {
			if (target?.navigation !== undefined && target.navigation !== navigationVersion) throw "cancel";
			if (e.code !== "LOCKED") throw e;
			await requestUnlock(e.lockPath, target);
			await load();
		}
	}
	throw Error("访问密码验证次数过多，请重新操作");
}
const guardedApi = (...args) => withAccess(() => api(...args));
const inScope = (resource, scope) => resource === scope || resource?.startsWith(scope + "/");
function clearNote() {
	clearTimeout(timer);
	selected.value = null;
	selectedTrash.value = null;
	content.value = "";
	title.value = "";
	dirty = false;
	revision++;
	historyDialog.value = false;
	historyPreview.value = null;
	history.value = [];
	attachmentDialog.value = false;
	shareDialog.value = false;
	jobs.value = [];
}
async function openFolder(path) {
	if (uploading.value) throw Error("请等待附件上传完成");
	const navigation = ++navigationVersion;
	loadingNavigation.value = navigation;
	try {
		cancelUnlock();
		await flush();
		if (navigation !== navigationVersion) return;
		clearNote();
		section.value = "all";
		folder.value = path;
		query.value = "";
		navOpen.value = false;
		if (isMobile.value) mobilePane.value = "list";
		rememberNavigation({ type: "folder", path });
		await withAccess(() => api("/access?path=" + encodeURIComponent(path)), {
			path,
			type: "folder",
			navigation,
		});
		if (navigation !== navigationVersion) return;
		await load();
		if (navigation !== navigationVersion) return;
		if (notes.value.length) await openNote(notes.value[0]);
	} finally {
		if (loadingNavigation.value === navigation) loadingNavigation.value = 0;
	}
}
function configureReadingPassword(reset = false, target = "") {
	lockTarget.value = target;
	readingReset.value = reset;
	readingError.value = "";
	lockForm.value = { current: "", login: "", password: "", confirm: "" };
	lockDialog.value = true;
	navOpen.value = false;
}
async function editLock(path) {
	if (!state.value.user?.accessPasswordConfigured) {
		configureReadingPassword(false, path);
		return;
	}
	await applyLock(path);
}
async function applyLock(path) {
	if (uploading.value) throw Error("请等待附件上传完成");
	await flush();
	await guardedApi("/locks/set", "POST", { path });
	if (inScope(selected.value?.path, path)) clearNote();
	await load();
	ElMessage.success("已使用账号阅读密码加锁，已有分享已撤销");
	const entry = state.value.entries.find((e) => e.path === path);
	if (entry?.type === "note") await openNote(entry);
	else if (entry?.type === "folder") await openFolder(path);
}
async function submitLock() {
	if (lockBusy.value) return;
	lockBusy.value = true;
	readingError.value = "";
	try {
		if (uploading.value) throw Error("请等待附件上传完成");
		if (lockForm.value.password.length < 6 || lockForm.value.password.length > 20) throw Error("阅读密码需为 6 至 20 位");
		if (lockForm.value.password !== lockForm.value.confirm) throw Error("两次输入的密码不一致");
		if (!pendingUnlock) await flush();
		await api("/account/access-password", "POST", {
			newPassword: lockForm.value.password,
			currentPassword: lockForm.value.current,
			loginPassword: lockForm.value.login,
			reset: readingReset.value,
		});
		await load();
		lockDialog.value = false;
		const target = lockTarget.value;
		lockForm.value = { current: "", login: "", password: "", confirm: "" };
		if (selected.value?.protected && !dirty) clearNote();
		ElMessage.success("账号阅读密码已保存，所有加锁内容使用此密码");
		lockBusy.value = false;
		if (target) await applyLock(target);
	} catch (e) {
		readingError.value = e.message || "操作失败";
	} finally {
		lockBusy.value = false;
	}
}
async function cancelReadingLock() {
	const pending = pendingUnlock,
		scope = lockPath.value;
	if (!pending || unlockBusy.value) return;
	unlockBusy.value = true;
	unlockError.value = "";
	try {
		await api("/locks/unlock", "POST", {
			path: lockPath.value,
			password: lockPassword.value,
		});
		if (pendingUnlock !== pending) return;
		if (scope.startsWith("@trash/")) throw Error("请先恢复回收站内容再取消加锁");
		await ElMessageBox.confirm(`将取消「${scope}」的加锁标记，文件夹中的内容会失去这一层保护。账号阅读密码保持不变。`, "取消阅读密码", { confirmButtonText: "取消加锁", cancelButtonText: "保留" });
		if (pendingUnlock !== pending) return;
		await api("/locks/remove", "POST", { path: scope });
		await load();
		if (pendingUnlock !== pending) return;
		const done = pendingUnlock;
		pendingUnlock = null;
		lockView.value = null;
		lockPassword.value = "";
		done?.resolve();
	} catch (e) {
		if (e !== "cancel" && e !== "close") unlockError.value = e.message;
	} finally {
		unlockBusy.value = false;
	}
}
async function removeLock(path) {
	await flush();
	await guardedApi("/locks/remove", "POST", { path });
	await load();
	if (selected.value)
		Object.assign(
			selected.value,
			state.value.entries.find((e) => e.path === selected.value.path),
		);
	ElMessage.success("已取消访问密码");
}
async function relock(path) {
	if (uploading.value) throw Error("请等待附件上传完成");
	await flush();
	const result = await api("/locks/relock", "POST", { path });
	if (result.scopes.some((scope) => inScope(selected.value?.path, scope))) clearNote();
	await load();
	ElMessage.success("已重新锁定");
}
const contextMenu = ref(null);
let contextMenuId = 0;
const contextResource = computed(() => {
	const target = contextMenu.value;
	if (!target?.path) return null;
	return state.value.entries.find((entry) => entry.path === target.path) || (selected.value?.path === target.path ? selected.value : null);
});
function folderMenuItems(resource) {
	return [
		{ command: "new", label: "新建笔记", icon: Plus },
		{ command: "new-folder", label: "添加文件夹", icon: FolderOpened },
		{ command: "rename", label: "移动/重命名", icon: EditPen },
		{ command: resource?.ownLock ? "unlock-remove" : "lock", label: resource?.ownLock ? "取消锁定" : "锁定", icon: Lock },
		{ command: "delete", label: "移入回收站", icon: Delete, divided: true, danger: true },
	].map((item) => ({ ...item, disabled: uploading.value || !resource }));
}
async function folderCommand(command, path) {
	if (command === "new") newItem("note", path);
	else if (command === "new-folder") newItem("folder", path);
	else await resourceCommand(command, path);
}
function activeNoteShare(path) {
	return state.value.shares.find((share) => share.path === path && (share.expires === 0 || share.expires > Date.now()));
}
function noteMenuItems(resource) {
	const favorited = state.value.favorites.includes(resource?.path);
	const shared = !!activeNoteShare(resource?.path);
	const lockCommand = resource?.ownLock ? "unlock-remove" : resource?.protected && resource?.locked ? "unlock-note" : "lock";
	return [
		{ command: "new", label: "新建笔记", icon: Plus },
		{ command: "rename", label: "重命名/移动", icon: EditPen },
		{ command: "duplicate", label: "复制笔记", icon: CopyDocument },
		{ command: "favorite", label: favorited ? "取消收藏" : "收藏", icon: favorited ? StarFilled : Star, favorited },
		{ command: shared ? "revoke-share" : "share", label: shared ? "取消分享" : "分享笔记", icon: Share, disabled: !shared && !!resource?.protected },
		{ command: "export", label: "导出Markdown", icon: Download },
		{ command: "history", label: "历史版本", icon: Clock },
		{ command: lockCommand, label: lockCommand === "lock" ? "加锁" : "解锁", icon: Lock },
		{ command: "focus", label: focusMode.value ? "退出专注模式" : "专注编辑", icon: focusMode.value ? Aim : FullScreen, disabled: isMobile.value },
		{ command: "delete", label: "移入回收站", icon: Delete, divided: true, danger: true },
	].map((item) => ({ ...item, disabled: item.disabled || uploading.value || !resource }));
}
const contextItems = computed(() => {
	const target = contextMenu.value;
	if (!target) return [];
	if (target.type === "empty") return [{ command: "new", label: "新建笔记", icon: Plus, disabled: uploading.value }];
	if (target.type === "folder") return folderMenuItems(contextResource.value);
	return noteMenuItems(contextResource.value);
});
function openContextMenu(event, type = "empty", path = "") {
	event.preventDefault();
	event.stopPropagation();
	contextMenu.value = { id: ++contextMenuId, x: event.clientX, y: event.clientY, type, path };
	listOptionsOpen.value = false;
}
function openListContext(event) {
	if (event.target.closest("input, textarea, button, .reading-lock-panel, .trash-card")) return;
	openContextMenu(event);
}
function openEditorContext(event) {
	if (selectedTrash.value || lockView.value?.type === "trash") return;
	const path = selected.value?.path || (lockView.value?.type === "note" ? lockView.value.path : "");
	openContextMenu(event, path ? "note" : "empty", path);
}
async function contextCommand(command) {
	const target = contextMenu.value;
	contextMenu.value = null;
	if (!target) return;
	await act(async () => {
		if (target.type === "folder" && ["new", "new-folder"].includes(command)) {
			await folderCommand(command, target.path);
			return;
		}
		if (command === "new") {
			const parent = target.type === "folder" ? target.path : target.type === "note" ? target.path.split("/").slice(0, -1).join("/") : folder.value;
			newItem("note", parent);
			return;
		}
		const resource = state.value.entries.find((entry) => entry.path === target.path) || (selected.value?.path === target.path ? selected.value : null);
		if (!resource) throw Error("内容已移动或删除，请刷新列表");
		if (target.type === "note" && ["favorite", "share", "duplicate", "export", "history", "focus"].includes(command)) {
			if (selected.value?.path !== target.path || lockView.value) await openNote(resource);
			if (selected.value?.path !== target.path || lockView.value) return;
		}
		await resourceCommand(command, target.path);
	});
}
watch([section, folder, ready, () => selected.value?.path], () => { contextMenu.value = null; });
async function resourceCommand(command, path) {
	await act(async () => {
		if (path === selected.value?.path) {
			await flush();
			path = selected.value.path;
		}
		if (command === "new") newItem("note", path.split("/").slice(0, -1).join("/"));
		else if (command === "favorite") await favorite();
		else if (command === "share") openShare();
		else if (command === "revoke-share") await revokeNoteShare(path);
		else if (command === "unlock-note") await openNote({ path });
		else if (command === "lock") await editLock(path);
		else if (command === "unlock-remove") await removeLock(path);
		else if (command === "relock") await relock(path);
		else if (command === "history") await openHistory();
		else if (command === "rename") renameItem(path);
		else if (command === "duplicate") await duplicate();
		else if (command === "export") downloadMarkdown();
		else if (command === "focus") focusMode.value = !focusMode.value;
		else await removeItem(path);
	});
}
async function openHistory() {
	await flush();
	historyPreview.value = null;
	history.value = (await guardedApi("/versions?path=" + encodeURIComponent(selected.value.path))).versions;
	historyDialog.value = true;
	if (history.value.length) await previewVersion(history.value[0]);
}
async function previewVersion(version) {
	historyBusy.value = true;
	try {
		historyPreview.value = await guardedApi(`/versions/${version.id}?path=` + encodeURIComponent(selected.value.path));
	} finally {
		historyBusy.value = false;
	}
}
async function snapshotVersion() {
	await flush();
	await guardedApi("/versions/snapshot", "POST", {
		path: selected.value.path,
		modified: selected.value.modified,
	});
	await openHistory();
	ElMessage.success("当前正文已记录");
}
async function restoreVersion() {
	await ElMessageBox.confirm("将恢复选中的正文，当前正文会先保存为一个版本。标题和位置保持当前设置。", "恢复正文", { confirmButtonText: "恢复", cancelButtonText: "取消" });
	await flush();
	await guardedApi("/versions/restore", "POST", {
		path: selected.value.path,
		id: historyPreview.value.id,
		modified: selected.value.modified,
	});
	const path = selected.value.path;
	await load();
	await openNote({ path });
	historyDialog.value = false;
	ElMessage.success("正文已恢复");
}
const appBase = import.meta.env.BASE_URL.replace(/\/$/, "");
let timer,
	revision = 0,
	dirty = false;
const activeUploads = ref(0),
	saveBusy = ref(false);
const noteName = (path) => path.split("/").at(-1).replace(/\.md$/i, "");
const noteCount = computed(() => state.value.entries.filter((e) => e.type === "note").length);
const folders = computed(() => state.value.entries.filter((e) => e.type === "folder").sort((a, b) => a.path.localeCompare(b.path)));
const destinations = computed(() => folders.value.filter((f) => !itemForm.value.from || (f.path !== itemForm.value.from && !f.path.startsWith(itemForm.value.from + "/"))));
const tree = computed(() => {
	const map = new Map(),
		roots = [];
	for (const entry of folders.value)
		map.set(entry.path, {
			...entry,
			label: entry.path.split("/").at(-1),
			children: [],
		});
	for (const node of map.values()) {
		const parent = map.get(node.path.slice(0, node.path.lastIndexOf("/")));
		if (node.path.includes("/") && parent) parent.children.push(node);
		else roots.push(node);
	}
	return roots;
});
const notes = computed(() =>
	state.value.entries
		.filter((e) => e.type === "note" && (section.value !== "favorites" || state.value.favorites.includes(e.path)) && (!folder.value || e.path.startsWith(folder.value + "/")) && (!query.value || (e.path + " " + (e.content ?? "")).toLowerCase().includes(query.value.toLowerCase())))
		.sort((a, b) => {
			const field = sort.value === "updated" ? "modified" : sort.value;
			const comparison = field === "name" ? noteName(a.path).localeCompare(noteName(b.path), "zh-CN", { numeric: true }) : (a[field] || 0) - (b[field] || 0);
			return (sortDirection.value === "asc" ? comparison : -comparison) || a.path.localeCompare(b.path);
		}),
);
const sectionTitle = computed(() => (section.value === "trash" ? "回收站" : section.value === "favorites" ? "我的收藏" : folder.value.split("/").at(-1) || "全部笔记"));
const uploading = computed(() => activeUploads.value > 0);
const attachments = computed(() => extractAttachments(content.value, state.value.attachments));
const formatSize = (size) => (size === undefined ? "" : size < 1024 ? size + " B" : size < 1048576 ? (size / 1024).toFixed(1) + " KB" : (size / 1048576).toFixed(1) + " MB");
const toolbars = ["revoke", "next", "-", "bold", "italic", "strikeThrough", "-", "title", "quote", "unorderedList", "orderedList", "task", "-", "codeRow", "code", "link", "image", "table", "=", "save", "catalog"];
const mobileToolbars = ["revoke", "next", "-", "bold", "italic", "title", "quote", "unorderedList", "task", "code", "link", "image", "table"];
async function act(fn) {
	error.value = "";
	try {
		return await fn();
	} catch (e) {
		if (e === "cancel" || e === "close") return;
		if (e.status === 401 && ready.value) {
			ready.value = false;
			navOpen.value = false;
			error.value = "登录已过期，请重新登录。未保存内容会保留在当前页面。";
			ElMessage.warning(error.value);
			return;
		}
		error.value = e.message || "操作失败";
		ElMessage.error(error.value);
	}
}
async function load() {
	state.value = await api("/state");
}
async function login() {
	if (loginBusy.value) return;
	loginBusy.value = true;
	await act(async () => {
		if (!initialized.value) {
			if (password.value.length < 6 || password.value.length > 20) throw Error("登录密码须为 6 至 20 位");
			if (password.value !== confirmPassword.value) throw Error("两次输入的密码不一致");
			await api("/register", "POST", {
				password: password.value,
			});
			initialized.value = true;
		}
		await api("/login", "POST", {
			password: password.value,
		});
		password.value = "";
		confirmPassword.value = "";
		await load();
		ready.value = true;
		if (dirty && selected.value) await flush();
		if (!selected.value && !lockView.value) void act(restoreNavigation);
	});
	loginBusy.value = false;
}
function navigationKey() {
	return "notespace:navigation:" + (state.value.nasUserId ?? "local");
}
function rememberNavigation(target = selected.value ? { type: "note", path: selected.value.path } : folder.value ? { type: "folder", path: folder.value } : null) {
	sessionStorage.setItem(navigationKey(), JSON.stringify({ section: section.value, folder: folder.value, target }));
}
async function restoreNavigation() {
	let saved;
	try {
		saved = JSON.parse(sessionStorage.getItem(navigationKey()) || "null");
	} catch {
		sessionStorage.removeItem(navigationKey());
	}
	if (!saved) return;
	section.value = ["all", "favorites", "trash"].includes(saved.section) ? saved.section : "all";
	folder.value = typeof saved.folder === "string" ? saved.folder : "";
	if (saved.target?.type === "folder") await openFolder(saved.target.path);
	else if (saved.target?.type === "note") await openNote({ path: saved.target.path });
	else if (saved.target?.type === "trash") {
		const item = state.value.trash.find((entry) => entry.id === saved.target.id);
		if (item) await openTrash(item);
		else await choose("trash");
	} else await choose(section.value, folder.value);
}
watch(() => selected.value?.path, (path) => {
	if (path) rememberNavigation({ type: "note", path });
});
async function choose(value, path = "") {
	if (uploading.value) throw Error("请等待附件上传完成");
	const navigation = ++navigationVersion;
	loadingNavigation.value = navigation;
	try {
		cancelUnlock();
		await flush();
		if (navigation !== navigationVersion) return;
		clearNote();
		section.value = value;
		folder.value = path;
		query.value = "";
		rememberNavigation(null);
		navOpen.value = false;
		if (isMobile.value) mobilePane.value = "list";
		await load();
		if (navigation !== navigationVersion) return;
		if (value === "trash") {
			if (state.value.trash.length) await openTrash(state.value.trash[0]);
		} else if (notes.value.length) await openNote(notes.value[0]);
	} finally {
		if (loadingNavigation.value === navigation) loadingNavigation.value = 0;
	}
}
async function openTrash(item) {
	if (uploading.value) throw Error("请等待附件上传完成");
	const navigation = ++navigationVersion;
	loadingNavigation.value = navigation;
	try {
		cancelUnlock();
		await flush();
		if (navigation !== navigationVersion) return;
		clearNote();
		const target = { type: "trash", id: item.id, path: item.resource || "@trash/" + item.id };
		rememberNavigation(target);
		const preview = await withAccess(() => api("/trash-preview?id=" + encodeURIComponent(item.id)), { ...target, navigation });
		if (navigation !== navigationVersion) return;
		selectedTrash.value = preview;
		if (isMobile.value) mobilePane.value = "editor";
	} finally {
		if (loadingNavigation.value === navigation) loadingNavigation.value = 0;
	}
}
async function openNote(note) {
	if (uploading.value) throw Error("附件正在上传，请完成后再切换笔记");
	const navigation = ++navigationVersion;
	loadingNavigation.value = navigation;
	try {
		cancelUnlock();
		await flush();
		if (navigation !== navigationVersion) return;
		clearNote();
		rememberNavigation({ type: "note", path: note.path });
		note = await withAccess(() => api("/note?path=" + encodeURIComponent(note.path)), { path: note.path, type: "note", navigation });
		if (navigation !== navigationVersion) return;
		selected.value = { ...note };
		editorSession.value++;
		title.value = note.title;
		content.value = note.content;
		dirty = false;
		revision++;
		saveStatus.value = "已保存";
		sessionStorage.setItem("notespace:last-note", note.path);
		rememberNavigation({ type: "note", path: note.path });
		jobs.value = [];
		if (isMobile.value) {
			mode.value = "edit";
			mobilePane.value = "editor";
			navOpen.value = false;
		}
	} finally {
		if (loadingNavigation.value === navigation) loadingNavigation.value = 0;
	}
}
async function backToList() {
	navigationVersion++;
	loadingNavigation.value = 0;
	cancelUnlock();
	await act(async () => {
		if (uploading.value) throw Error("请等待附件上传完成");
		await flush();
		mobilePane.value = "list";
	});
}
function downloadMarkdown() {
	const blob = URL.createObjectURL(new Blob([content.value], { type: "text/markdown;charset=utf-8" }));
	const link = document.createElement("a");
	link.href = blob;
	link.download = selected.value?.path.split("/").at(-1) || "未保存笔记.md";
	link.click();
	setTimeout(() => URL.revokeObjectURL(blob), 1000);
}
function openPasswordDialog() {
	passwordForm.value = { current: "", next: "", confirm: "" };
	passwordError.value = "";
	passwordDialog.value = true;
}
async function changePassword() {
	if (passwordBusy.value) return;
	passwordBusy.value = true;
	passwordError.value = "";
	try {
		if (uploading.value) throw Error("请等待附件上传完成");
		if (passwordForm.value.next.length < 6 || passwordForm.value.next.length > 20) throw Error("登录密码须为 6 至 20 位");
		if (passwordForm.value.next !== passwordForm.value.confirm) throw Error("两次输入的新密码不一致");
		await flush();
		await api("/account/password", "POST", {
			currentPassword: passwordForm.value.current,
			newPassword: passwordForm.value.next,
		});
		passwordForm.value = { current: "", next: "", confirm: "" };
		passwordDialog.value = false;
		settings.value = false;
		ready.value = false;
		password.value = "";
		ElMessage.success("密码已更新，请重新登录");
	} catch (e) {
		passwordError.value = e.message;
	} finally {
		passwordBusy.value = false;
	}
}
function networkChange() {
	offline.value = !navigator.onLine;
	if (!offline.value && dirty && ready.value) act(flush);
}
function updateContent(value) {
	if (value === content.value) return;
	content.value = value;
	markDirty();
}
function updateTitle(value) {
	title.value = value;
	markDirty();
}
function markDirty() {
	dirty = true;
	revision++;
	saveStatus.value = "等待保存";
	clearTimeout(timer);
	timer = setTimeout(() => act(flush), 700);
}
const saveQueue = createSaveQueue({
	isDirty: () => dirty && !!selected.value,
	snapshot: () => ({
		note: selected.value,
		text: content.value,
		title: title.value,
		version: revision,
	}),
	write: async ({ note, text, title }) => {
		saveStatus.value = "保存中";
		return guardedApi("/note", "PUT", {
			path: note.path,
			content: text,
			title,
			modified: note.modified,
		});
	},
	commit: ({ note, text, version }, result) => {
		const previous = note.path;
		const old = state.value.entries.find((e) => e.path === previous);
		Object.assign(note, result);
		note.modified = result.modified;
		note.content = text;
		if (old) Object.assign(old, result, { content: text });
		state.value.favorites = state.value.favorites.map((path) => (path === previous ? result.path : path));
		state.value.shares.forEach((share) => {
			if (share.path === previous) share.path = result.path;
		});
		sessionStorage.setItem("notespace:last-note", result.path);
		if (version === revision) {
			dirty = false;
			title.value = result.title;
			saveStatus.value = "已保存";
		}
	},
	onError: () => (saveStatus.value = "保存失败"),
});
async function flush() {
	clearTimeout(timer);
	saveBusy.value = true;
	try {
		await saveQueue();
	} finally {
		saveBusy.value = false;
	}
}
async function manualSave() {
	await act(async () => {
		await flush();
		ElMessage.success("笔记已保存到 NAS");
	});
}
function newItem(kind = "note", parent = folder.value) {
	if (uploading.value) return ElMessage.warning("请等待附件上传完成");
	error.value = "";
	itemForm.value = { kind, name: "", parent, from: "" };
	itemDialog.value = true;
	navOpen.value = false;
}
function renameItem(path) {
	if (uploading.value) return ElMessage.warning("请等待附件上传完成");
	error.value = "";
	itemForm.value = {
		kind: state.value.entries.find((e) => e.path === path)?.type || "note",
		name: state.value.entries.find((e) => e.path === path)?.type === "folder" ? path.split("/").at(-1) : noteName(path),
		parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
		from: path,
	};
	itemDialog.value = true;
	navOpen.value = false;
}
async function submitItem() {
	if (itemBusy.value) return;
	itemBusy.value = true;
	await act(async () => {
		await flush();
		const form = itemForm.value,
			name = form.name.trim();
		if (!name || /[\\/:*?"<>|]/.test(name) || name.startsWith(".")) throw Error("名称不能为空，且不能包含路径分隔符或特殊字符");
		const key = (form.parent ? form.parent + "/" : "") + name + (form.kind === "note" ? ".md" : "");
		if (form.from === key) {
			itemDialog.value = false;
			return;
		}
		if (state.value.entries.some((e) => e.path === key)) throw Error("该目录中已经存在同名内容");
		if (form.from) await guardedApi("/move", "POST", { from: form.from, to: key });
		else if (form.kind === "folder") await guardedApi("/folder", "POST", { path: key });
		else
			await guardedApi("/note", "PUT", {
				path: key,
				content: "# " + name + "\n\n",
				modified: null,
			});
		const previous = selected.value?.path;
		await load();
		if (form.kind === "note") {
			selected.value = null;
			await openNote(state.value.entries.find((e) => e.path === key));
			section.value = "all";
			folder.value = form.parent;
		} else if (form.from && previous?.startsWith(form.from + "/")) {
			selected.value = null;
			await openNote(state.value.entries.find((e) => e.path === key + previous.slice(form.from.length)));
		}
		if (form.kind === "folder" && folder.value === form.from) folder.value = key;
		itemDialog.value = false;
		ElMessage.success(form.from ? "已更新名称与位置" : "创建成功");
	});
	itemBusy.value = false;
}
async function removeItem(path) {
	await act(async () => {
		if (uploading.value) throw Error("请等待上传完成");
		await ElMessageBox.confirm("内容将移入回收站，文件夹中的笔记也会一起移动。", "移入回收站", {
			type: "warning",
			confirmButtonText: "移入回收站",
			cancelButtonText: "取消",
		});
		await flush();
		await guardedApi("/delete", "POST", { path });
		if (selected.value?.path === path || selected.value?.path.startsWith(path + "/")) {
			selected.value = null;
			content.value = "";
		}
		if (folder.value === path || folder.value.startsWith(path + "/")) await choose("all");
		await load();
		ElMessage.success("已移入回收站");
	});
}
async function favorite() {
	await act(async () => {
		await guardedApi("/favorite", "POST", { path: selected.value.path });
		await load();
	});
}
async function duplicate() {
	await act(async () => {
		if (uploading.value) throw Error("请等待附件上传完成");
		await flush();
		const original = selected.value;
		let path = original.path.replace(/\.md$/, " - 副本.md"),
			i = 2;
		while (state.value.entries.some((e) => e.path === path)) path = original.path.replace(/\.md$/, ` - 副本 ${i++}.md`);
		await guardedApi("/note", "PUT", {
			path,
			content: content.value,
			modified: null,
		});
		await load();
		await openNote(state.value.entries.find((e) => e.path === path));
	});
}
async function processUpload(file) {
	const job = {
		id: createUploadId(),
		name: file.name,
		size: file.size,
		progress: 0,
		status: "uploading",
		error: "",
	};
	jobs.value.push(job);
	const live = () => jobs.value.find((j) => j.id === job.id);
	try {
		const result = await withAccess(() => uploadFile(file, (percent) => (live().progress = percent), selected.value.path));
		Object.assign(live(), { status: "success", url: result.url });
		state.value.attachments ??= [];
		state.value.attachments.push({ ...result, size: file.size });
		return result;
	} catch (e) {
		Object.assign(live(), { status: "error", error: e.message });
		throw e;
	}
}
function markdownAttachment(file, result) {
	const label = file.name.replace(/[\[\]\\\r\n]/g, "_");
	const image = /^image\/(png|jpeg|gif|webp|bmp)$/i.test(file.type);
	return `\n${image ? "!" : ""}[${label}](${result.url})\n`;
}
async function insertMarkdown(text) {
	if (mode.value === "preview") {
		mode.value = "split";
		await nextTick();
	}
	if (editor.value) editor.value.insert(() => ({ targetValue: text, select: false }));
	else updateContent(content.value + text);
	await nextTick();
}
async function uploadRequest(options) {
	activeUploads.value++;
	try {
		if (!selected.value) throw Error("请先选择或新建笔记");
		await flush();
		const result = await processUpload(options.file);
		await insertMarkdown(markdownAttachment(options.file, result));
		await flush();
		options.onSuccess(result);
		ElMessage.success("附件已上传并插入笔记");
	} catch (e) {
		options.onError(e);
		error.value = e.message;
		ElMessage.error(e.message);
	} finally {
		activeUploads.value--;
	}
}
async function uploadImages(files, callback) {
	activeUploads.value++;
	try {
		await act(async () => {
			await flush();
			const urls = [];
			for (const file of files) {
				const result = await processUpload(file);
				urls.push({ url: result.url, alt: file.name, title: file.name });
			}
			callback(urls);
			await nextTick();
			await flush();
			ElMessage.success("图片已上传到 NAS");
		});
	} finally {
		activeUploads.value--;
	}
}
async function dropFiles(event) {
	if (!event.dataTransfer?.files.length) return;
	event.preventDefault();
	event.stopPropagation();
	for (const file of event.dataTransfer.files) await uploadRequest({ file, onSuccess: () => {}, onError: () => {} });
}
async function revokeNoteShare(path) {
	const share = activeNoteShare(path);
	if (!share) return;
	await ElMessageBox.confirm("取消分享后，原链接将无法访问。", "取消分享", { confirmButtonText: "取消分享", cancelButtonText: "保留分享", type: "warning" });
	await api("/revoke", "POST", { token: share.token });
	await load();
	ElMessage.success("已取消分享");
}
function openShare() {
	if (!selected.value) return;
	if (selected.value.protected) return ElMessage.warning("加锁内容不能分享");
	shareLink.value = "";
	sharePassword.value = "";
	shareHours.value = 24;
	shareDialog.value = true;
}
async function share() {
	if (shareBusy.value) return;
	shareBusy.value = true;
	await act(async () => {
		await flush();
		const result = await api("/share", "POST", {
			path: selected.value.path,
			password: sharePassword.value,
			hours: shareHours.value,
		});
		shareLink.value = location.origin + appBase + "/s/" + result.token;
		await load();
	});
	shareBusy.value = false;
}
async function copyLink() {
	await act(async () => {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(shareLink.value);
			ElMessage.success("分享链接已复制");
			return;
		}
		const input = document.createElement("textarea");
		input.value = shareLink.value;
		input.style.position = "fixed";
		input.style.top = "0";
		input.style.left = "0";
		input.style.opacity = "0";
		document.body.appendChild(input);
		input.focus();
		input.select();
		let copied = false;
		try {
			copied = document.execCommand("copy");
		} finally {
			input.remove();
		}
		if (copied) ElMessage.success("分享链接已复制");
		else ElMessage.info("请长按或选中分享链接进行复制");
	});
}
async function trashAction(item, purge = false) {
	if (trashBatchBusy.value) return;
	await act(async () => {
		if (purge)
			await ElMessageBox.confirm("永久删除后无法恢复。", "永久删除", {
				type: "warning",
				confirmButtonText: "永久删除",
				cancelButtonText: "取消",
			});
		await guardedApi(purge ? "/purge" : "/restore", "POST", { id: item.id });
		await load();
		if (section.value === "trash" && (selectedTrash.value?.id === item.id || !selectedTrash.value)) {
			if (state.value.trash.length) await openTrash(state.value.trash[0]);
			else {
				clearNote();
				rememberNavigation(null);
			}
		}
		ElMessage.success(purge ? "已永久删除" : "已恢复到原目录");
	});
}
async function batchTrashAction(purge = false) {
	if (trashBatchBusy.value || !checkedTrashIds.value.length) return;
	const items = state.value.trash.filter((item) => checkedTrashIds.value.includes(item.id));
	trashBatchBusy.value = true;
	trashBatchError.value = "";
	await act(async () => {
		let started = false, completed = 0, cancelled = false;
		const failures = [];
		try {
			if (purge) await ElMessageBox.confirm(`确定永久删除选中的 ${items.length} 项内容吗？文件夹中的内容也会删除，无法恢复。`, "批量永久删除", {
				confirmButtonText: "永久删除",
				cancelButtonText: "取消",
				type: "warning",
			});
			started = true;
			for (const item of items) {
				try {
					await guardedApi(purge ? "/purge" : "/restore", "POST", { id: item.id });
					completed++;
					checkedTrashIds.value = checkedTrashIds.value.filter((id) => id !== item.id);
				} catch (error) {
					if (error === "cancel" || error === "close") { cancelled = true; break; }
					if (error.status === 401) throw error;
					failures.push(`${item.path}：${error.message || "操作失败"}`);
				}
			}
			trashBatchError.value = failures.join("；");
			if (failures.length || cancelled) ElMessage.warning(`已${purge ? "删除" : "恢复"} ${completed} 项，未完成的内容保留在回收站`);
			else ElMessage.success(`已${purge ? "永久删除" : "恢复"} ${completed} 项内容`);
		} finally {
			trashBatchBusy.value = false;
			if (started) {
				await load();
				if (section.value === "trash" && !lockView.value) {
					const item = state.value.trash.find((entry) => entry.id === selectedTrash.value?.id) || state.value.trash[0];
					if (item) await openTrash(item);
					else { clearNote(); rememberNavigation(null); }
				}
			}
		}
	});
	trashBatchBusy.value = false;
}
async function backup() {
	backupBusy.value = true;
	await act(async () => {
		await flush();
		const result = await guardedApi("/backup", "POST", {});
		await ElMessageBox.alert(result.path, "备份完成", {
			confirmButtonText: "知道了",
		});
	});
	backupBusy.value = false;
}
async function logout() {
	await act(async () => {
		await ElMessageBox.confirm("确定退出登录吗？", "退出登录", {
			confirmButtonText: "退出登录",
			cancelButtonText: "取消",
			type: "warning",
		});
		if (uploading.value) throw Error("请等待附件上传完成");
		await flush();
		await api("/logout", "POST");
		navigationVersion++;
		loadingNavigation.value = 0;
		cancelUnlock();
		sessionStorage.removeItem(navigationKey());
		ready.value = false;
		clearNote();
		state.value = {
			entries: [],
			favorites: [],
			shares: [],
			trash: [],
			attachments: [],
		};
		sessionStorage.removeItem("notespace:last-note");
	});
}
async function refresh() {
	await act(async () => {
		if (uploading.value) throw Error("请等待附件上传完成");
		await flush();
		await load();
		if (lockView.value) return;
		if (section.value === "trash") {
			const item = state.value.trash.find((entry) => entry.id === selectedTrash.value?.id) || state.value.trash[0];
			if (item) await openTrash(item);
			else clearNote();
			return;
		}
		if (selected.value) {
			const note = state.value.entries.find((e) => e.path === selected.value.path);
			if (note) await openNote(note);
			else if (folder.value) await openFolder(folder.value);
			else if (notes.value.length) await openNote(notes.value[0]);
			else clearNote();
		}
		else if (folder.value) await openFolder(folder.value);
		else if (notes.value.length) await openNote(notes.value[0]);
	});
}
function beforeUnload(e) {
	if (dirty || saveBusy.value || uploading.value) {
		e.preventDefault();
		e.returnValue = "";
	}
}
function keydown(e) {
	if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
		e.preventDefault();
		if (isMobile.value) mobilePane.value = "list";
		nextTick(() => searchInput.value?.focus());
		return;
	}
	if (isMobile.value && navOpen.value) {
		if (e.key === "Escape") {
			e.preventDefault();
			navOpen.value = false;
			return;
		}
		if (e.key === "Tab") {
			const items = [...document.querySelectorAll('.sidebar button:not([disabled]), .sidebar a[href], .sidebar [tabindex="0"]')].filter((node) => node.getClientRects().length);
			if (items.length) {
				if (e.shiftKey && document.activeElement === items[0]) {
					e.preventDefault();
					items.at(-1).focus();
				} else if (!e.shiftKey && document.activeElement === items.at(-1)) {
					e.preventDefault();
					items[0].focus();
				}
			}
		}
	}
	if ((e.ctrlKey || e.metaKey) && e.key === "s" && selected.value) {
		e.preventDefault();
		act(flush);
	}
}
onMounted(async () => {
	deviceChange();
	deviceQuery.addEventListener("change", deviceChange);
	window.visualViewport?.addEventListener("resize", deviceChange);
	window.addEventListener("resize", deviceChange);
	window.addEventListener("online", networkChange);
	window.addEventListener("offline", networkChange);
	window.addEventListener("beforeunload", beforeUnload);
	window.addEventListener("keydown", keydown);
	try {
		initialized.value = (await api("/status")).initialized;
		if (initialized.value) {
			try {
				await load();
				ready.value = true;
				void act(restoreNavigation);
			} catch (e) {
				if (e.status !== 401) throw e;
			}
		}
	} catch (e) {
		error.value = e.message;
	} finally {
		booting.value = false;
	}
});
onBeforeUnmount(() => {
	document.documentElement.style.removeProperty("--app-height");
	deviceQuery.removeEventListener("change", deviceChange);
	window.visualViewport?.removeEventListener("resize", deviceChange);
	window.removeEventListener("resize", deviceChange);
	window.removeEventListener("online", networkChange);
	window.removeEventListener("offline", networkChange);
	clearTimeout(timer);
	window.removeEventListener("beforeunload", beforeUnload);
	window.removeEventListener("keydown", keydown);
});
</script>

<template>
	<div v-if="booting" class="boot-screen" v-loading="true">
	</div>
	<div v-else-if="!ready" class="login-page">
		<section class="login-intro">
			<div class="brand">
				<div class="brand-mark">
					<img :src="logoUrl" alt="知间笔记 Logo" />
				</div>
				<div>
					知间笔记
					<span>NoteSpace</span>
				</div>
			</div>
			<div class="intro-copy">
				<span class="eyebrow">PRIVATE NOTES, YOUR OWN SPACE</span>
				<h1>
					记录有处可放，
					<br />
					想法自在生长。
				</h1>
				<p>以 Markdown 记录日常，用文件夹整理内容。 <br /> 笔记与附件，始终留在自己的 NAS 上。</p>
				<div class="intro-tags">
					<span><el-icon><Lock /></el-icon> 私有存储</span>
					<span><el-icon><EditPen /></el-icon> 即写即存</span>
					<span><el-icon><Folder /></el-icon> 文件管理</span>
				</div>
			</div>
			<small>知间笔记 · 一处安静的私人空间</small>
		</section>
		<section class="login-form">
			<div v-if="isMobile" class="brand mobile-login-brand">
				<div class="brand-mark">
					<img :src="logoUrl" alt="知间笔记 Logo" />
				</div>
				<div>
					知间笔记
					<span>NoteSpace</span>
				</div>
			</div>
			<el-card shadow="never">
				<el-tag effect="plain">{{ initialized ? "欢迎回来" : "首次使用" }}</el-tag>
				<h2>{{ initialized ? "登录知间笔记" : "设置登录密码" }}</h2>
				<p>{{ initialized ? "输入登录密码，查看和编辑你的笔记。" : "设置一个登录密码，保护你的笔记。" }}</p>
				<el-form @keydown="submitFormOnEnter" label-position="top" @submit.prevent="login">
					<el-form-item :label="initialized ? '登录密码' : '登录密码（6 至 20 位）'">
						<el-input v-model="password" size="large" type="password" show-password :prefix-icon="Lock" :autocomplete="initialized ? 'current-password' : 'new-password'" maxlength="20" :placeholder="initialized ? '请输入登录密码' : '请设置 6 至 20 位的登录密码'" />
					</el-form-item>
					<el-form-item v-if="!initialized" label="确认密码">
						<el-input v-model="confirmPassword" type="password" show-password size="large" autocomplete="new-password" maxlength="20" placeholder="再次输入密码" />
					</el-form-item>
					<el-button type="primary" size="large" native-type="submit" :loading="loginBusy" class="login-submit">{{ initialized ? "登录" : "保存密码并开始使用" }} <el-icon><ArrowRight /></el-icon></el-button>
				</el-form>
				<el-alert v-if="error && !lockView" :title="error" type="error" :closable="false" />
				<div class="login-foot">
					<el-icon><Lock /></el-icon>
					内容存储在你的设备，不依赖第三方云
				</div>
			</el-card>
		</section>
	</div>
	<div v-else class="app-shell" :class="{ 'focus-mode': focusMode && !isMobile, 'sidebar-collapsed': sidebarCollapsed && !isMobile, 'mobile-editor': mobilePane === 'editor', 'mobile-nav-open': navOpen, }" :style="{ '--app-height': viewportHeight + 'px' }">
		<header v-if="isMobile" class="mobile-header" :inert="navOpen">
			<el-button text :icon="mobilePane === 'editor' ? ArrowLeft : Menu" @click="mobilePane === 'editor' ? backToList() : (navOpen = true)" :aria-label="mobilePane === 'editor' ? '返回笔记列表' : '打开导航'" />
			<strong>{{ mobilePane === "editor" && lockView ? (lockView.type === "folder" ? lockView.path.split("/").at(-1) : noteName(lockView.path)) : mobilePane === "editor" && selected ? noteName(selected.path) : sectionTitle }}</strong>
			<el-button text :icon="FolderOpened" @click="navOpen = true" aria-label="打开文件夹导航" />
			<el-button text :icon="Plus" @click="newItem('note')" aria-label="新建笔记" />
		</header>
		<div v-if="isMobile && navOpen" class="mobile-nav-backdrop" @click="navOpen = false">
		</div>
		<aside v-show="isMobile || !sidebarCollapsed" id="folder-sidebar" class="sidebar" :inert="isMobile && !navOpen" :aria-hidden="isMobile && !navOpen" @contextmenu.prevent.stop="contextMenu = null">
			<el-button v-if="isMobile" class="mobile-nav-close" text @click="navOpen = false">关闭导航</el-button>
			<div class="brand">
				<el-tooltip v-if="!isMobile" content="收起侧栏">
					<el-button class="sidebar-collapse-button" text :icon="Fold" @click="sidebarCollapsed = true" aria-label="收起侧栏" aria-controls="folder-sidebar" :aria-expanded="true" />
				</el-tooltip>
				<div class="brand-mark">
					<img :src="logoUrl" alt="知间笔记 Logo" />
				</div>
				<div>
					知间笔记
					<span>NoteSpace</span>
				</div>
			</div>
			<el-button type="primary" :icon="Plus" class="new-note-button" @click="newItem('note')">新建笔记</el-button>
			<div class="sidebar-library">
				<div class="library-navigation">
					<el-menu :default-active="folder ? 'folder' : section" @select="(key) => act(() => choose(key))">
						<el-menu-item index="all">
							<el-icon><Document /></el-icon>
							<span>全部笔记</span>
							<span class="nav-count">{{ noteCount }}</span>
						</el-menu-item>
					</el-menu>
				</div>
				<el-scrollbar class="folder-scroll">
					<el-tree v-if="folders.length" :data="tree" :indent="12" node-key="path" :current-node-key="folder" highlight-current default-expand-all :expand-on-click-node="false" @node-click="(node) => act(() => openFolder(node.path))">
						<template #default="{ data }">
							<div class="tree-row" @contextmenu="openContextMenu($event, 'folder', data.path)">
								<el-icon><FolderOpened v-if="folder === data.path" /> <Folder v-else /></el-icon>
								<span>{{ data.label }}</span>
								<el-icon v-if="data.protected" :title="data.locked ? '已锁定' : '已解锁'"><Lock /></el-icon>
								<el-dropdown trigger="click" @command="(cmd) => folderCommand(cmd, data.path)">
									<el-button class="tree-more" text :icon="MoreFilled" @click.stop aria-label="文件夹操作" />
									<template #dropdown>
										<el-dropdown-menu>
											<el-dropdown-item v-for="item in folderMenuItems(data)" :key="item.command" :command="item.command" :icon="item.icon" :disabled="item.disabled" :divided="item.divided" :class="{ 'folder-menu-danger': item.danger }">{{ item.label }}</el-dropdown-item>
										</el-dropdown-menu>
									</template>
								</el-dropdown>
							</div>
						</template>
					</el-tree>
					<div v-if="!folders.length" class="folder-empty">
						还没有文件夹
						<br />
						<el-button link type="primary" @click="newItem('folder')">创建一个文件夹</el-button>
					</div>
				</el-scrollbar>
			</div>
			<div class="sidebar-footer">
				<div class="storage-status"><i></i> NAS 本地存储 <el-tag size="small" type="success" effect="plain">私有</el-tag></div>
				<el-button class="sidebar-utility-nav" :class="{ 'is-active': section === 'favorites' && !folder }" text :icon="Star" :aria-current="section === 'favorites' && !folder ? 'page' : undefined" @click="act(() => choose('favorites'))">我的收藏 <span class="nav-count">{{ state.favorites.length }}</span></el-button>
				<el-button class="sidebar-utility-nav" :class="{ 'is-active': section === 'trash' }" text :icon="Delete" :aria-current="section === 'trash' ? 'page' : undefined" @click="act(() => choose('trash'))">回收站 <span class="nav-count">{{ state.trash.length }}</span></el-button>
				<el-button text :icon="Setting" @click=" settings = true; navOpen = false; ">设置与备份</el-button>
				<el-button text :icon="SwitchButton" @click="logout" aria-label="退出登录" />
				<el-button text :icon="Share" class="share-management-nav" @click=" shareManagementOpen = true; navOpen = false; ">分享管理</el-button>
				<el-button class="theme-toggle-nav" text :icon="isDark ? Sunny : Moon" @click="toggleTheme" :aria-label="isDark ? '切换浅色模式' : '切换深色模式'">{{ isDark ? "浅色模式" : "深色模式" }}</el-button>
			</div>
		</aside>
		<section class="list-panel" :class="{ 'compact-list': listView === 'compact', 'comfortable-list': listView === 'comfortable' }" :inert="isMobile && navOpen" @contextmenu="openListContext">
			<div class="search-wrap">
				<el-tooltip v-if="sidebarCollapsed && !isMobile" content="展开侧栏">
					<el-button class="sidebar-expand-button" text :icon="Expand" @click="sidebarCollapsed = false" aria-label="展开侧栏" aria-controls="folder-sidebar" :aria-expanded="false" />
				</el-tooltip>
				<el-input ref="searchInput" v-model="query" :disabled="folderUnlock" :prefix-icon="Search" clearable placeholder="搜索笔记 Ctrl+Shift+F" aria-label="搜索笔记标题和正文" />
				<el-tooltip content="刷新列表">
					<el-button text :icon="Refresh" class="list-toolbar-button" @click="refresh" aria-label="刷新列表" />
				</el-tooltip>
				<el-popover v-if="section !== 'trash' && !folderUnlock" v-model:visible="listOptionsOpen" trigger="click" placement="bottom-end" :width="180" popper-class="note-list-options-popper">
					<template #reference>
						<el-button text :icon="Operation" class="list-options-button" aria-label="笔记列表显示和排序设置" :aria-expanded="listOptionsOpen" />
					</template>
					<div class="list-options-menu" role="menu">
						<div class="list-options-title">排序方式</div>
						<button v-for="option in sortOptions" :key="option.key" type="button" class="list-option-item" :class="{ active: sort === option.key }" role="menuitemradio" :aria-checked="sort === option.key" @click="selectListOption('sort:' + option.key)">{{ option.label }} <el-icon><component :is="sortDirection === 'asc' ? ArrowUp : ArrowDown" v-if="sort === option.key" /></el-icon></button>
						<div class="list-options-divider" role="separator">
						</div>
						<button type="button" class="list-option-item" role="menuitemcheckbox" :aria-checked="showListDates" @click="selectListOption('dates')">显示日期 <el-icon><Check v-if="showListDates" /></el-icon></button>
					</div>
				</el-popover>
			</div>
			<header class="list-header">
				<div>
					<h2>{{ sectionTitle }}</h2>
				</div>
				<span v-if="!folderUnlock" class="list-meta">{{ section === "trash" ? state.trash.length : notes.length }} 篇 {{ section === "trash" ? "已删除内容" : "笔记" }}</span>
			</header>
			<div v-if="section === 'trash' && state.trash.length" class="trash-batch-toolbar">
				<div class="trash-batch-selection">
					<el-checkbox :model-value="allTrashChecked" :indeterminate="someTrashChecked" :disabled="trashBatchBusy" @change="selectAllTrash">全选</el-checkbox>
					<span>已选 {{ checkedTrashIds.length }} 项</span>
				</div>
				<div class="trash-batch-actions">
					<el-button size="small" link type="primary" :icon="Refresh" :disabled="!checkedTrashIds.length || trashBatchBusy" @click="batchTrashAction()">恢复所选</el-button>
					<el-button size="small" link type="danger" :icon="Delete" :disabled="!checkedTrashIds.length || trashBatchBusy" @click="batchTrashAction(true)">永久删除</el-button>
				</div>
				<span v-if="trashBatchBusy" class="trash-batch-progress">正在处理，请稍候…</span>
			</div>
			<el-alert v-if="section === 'trash' && trashBatchError" class="trash-batch-error" type="warning" :title="trashBatchError" show-icon @close="trashBatchError = ''" />
			<section v-if="folderUnlock" class="reading-lock-panel" aria-label="阅读密码解锁">
				<div class="reading-lock-context">{{ lockView.path.startsWith("@trash/") ? "回收站中的加锁内容" : lockView.path }}</div>
				<el-form @keydown="submitFormOnEnter" class="reading-lock-form" @submit.prevent="submitUnlock">
					<el-icon class="reading-lock-icon"><Lock /></el-icon>
					<p>输入阅读密码解锁 {{ lockView.type === "folder" ? "文件夹" : "笔记" }}</p>
					<el-input v-model="lockPassword" type="password" show-password autocomplete="off" aria-label="阅读密码" placeholder="请输入阅读密码" :disabled="unlockBusy" />
					<el-alert v-if="unlockError" :title="unlockError" type="error" :closable="false" class="lock-feedback" />
					<el-button class="reading-unlock-button" type="primary" native-type="submit" :loading="unlockBusy">解锁</el-button>
					<div class="reading-lock-links">
						<el-button link :disabled="unlockBusy" @click="cancelReadingLock">取消阅读密码</el-button>
						<span></span>
						<el-button link :disabled="unlockBusy" @click="configureReadingPassword(true)">{{ state.user?.accessPasswordConfigured ? "忘记密码" : "设置阅读密码" }}</el-button>
					</div>
				</el-form>
			</section>
			<el-scrollbar v-else class="notes-scroll">
				<template v-if="section === 'trash'">
					<div v-for="item in state.trash" :key="item.id" class="trash-card" :class="{ selected: selectedTrash?.id === item.id || lockView?.id === item.id, checked: checkedTrashIds.includes(item.id) }" role="button" tabindex="0" :aria-disabled="trashBatchBusy" @click="!trashBatchBusy && act(() => openTrash(item))" @keydown.enter.self.prevent="!trashBatchBusy && act(() => openTrash(item))" @keydown.space.self.prevent="!trashBatchBusy && act(() => openTrash(item))">
						<el-checkbox class="trash-item-checkbox" :model-value="checkedTrashIds.includes(item.id)" :disabled="trashBatchBusy" :aria-label="'选择 ' + item.path" @click.stop @change="(checked) => selectTrash(item.id, checked)" />
						<div class="trash-card-body">
							<div class="trash-card-title">
								<el-icon><Document v-if="item.path.endsWith('.md')" /> <Folder v-else /></el-icon>
								<strong :title="item.path">{{ noteName(item.path) }}</strong>
								<el-icon v-if="item.protected" title="加锁内容"><Lock /></el-icon>
							</div>
							<div v-if="item.path.includes('/')" class="trash-card-location" :title="item.path">{{ item.path.slice(0, item.path.lastIndexOf('/')) }}</div>
							<div class="trash-card-meta">
								<time :datetime="new Date(item.deleted).toISOString()" :title="'删除时间：' + new Date(item.deleted).toLocaleString()">{{ new Date(item.deleted).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }}</time>
								<el-dropdown trigger="click" @command="(command) => trashAction(item, command === 'purge')">
									<el-button class="trash-card-more" text :icon="MoreFilled" :disabled="trashBatchBusy" aria-label="回收站内容操作" @click.stop />
									<template #dropdown>
										<el-dropdown-menu>
											<el-dropdown-item command="restore" :icon="Refresh">恢复到原位置</el-dropdown-item>
											<el-dropdown-item command="purge" :icon="Delete" divided class="folder-menu-danger">永久删除</el-dropdown-item>
										</el-dropdown-menu>
									</template>
								</el-dropdown>
							</div>
						</div>
					</div>
				</template>
				<template v-else>
					<button v-for="note in notes" :key="note.path" class="note-card" :class="{ selected: (lockView?.path || selected?.path) === note.path, }" @click="act(() => openNote(note))" @contextmenu="openContextMenu($event, 'note', note.path)">
						<div class="note-card-heading">
							<span class="markdown-file-icon" aria-hidden="true">M</span>
							<strong :title="noteName(note.path)">{{ noteName(note.path) }}</strong>
							<el-icon v-if="note.protected" :title="note.locked ? '已锁定，点击输入密码' : '已解锁'"><Lock /></el-icon>
							<el-icon v-if="state.favorites.includes(note.path)" class="star-icon"><StarFilled /></el-icon>
						</div>
						<div v-if="showListDates" class="note-card-footer">
							<span>{{ new Date(note.modified).toLocaleDateString() }}</span>
							<span v-if="note.path.includes('/')">{{ note.path.slice(0, note.path.lastIndexOf("/")) }}</span>
						</div>
					</button>
				</template>
				<el-empty v-if="!(section === 'trash' ? state.trash.length : notes.length)" :image-size="75" :description="query ? '没有找到匹配的笔记' : '没有笔记'">
					<el-button v-if="section === 'all' && !query" type="primary" plain :icon="Plus" @click="newItem('note')">新建笔记</el-button>
				</el-empty>
			</el-scrollbar>
			<footer class="list-footer">
				{{ folder || "所有文件夹" }}
				<el-icon><Lock /></el-icon>
			</footer>
		</section>
		<main class="editor-panel" :inert="isMobile && navOpen" @contextmenu="openEditorContext">
			<el-alert v-if="offline && !lockView" title="网络已断开，编辑内容暂留在页面中，连接恢复后会重试保存。" type="warning" :closable="false" show-icon />
			<el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />
			<template v-if="selected && !lockView">
				<div v-if="saveStatus === '保存失败'" class="save-recovery">
					<span>编辑内容尚未保存，请重试或导出副本。</span>
					<el-button link type="primary" @click="manualSave">重试保存</el-button>
					<el-button link type="primary" @click="downloadMarkdown">导出 Markdown</el-button>
				</div>
				<header class="editor-header">
					<el-breadcrumb separator="/">
						<el-breadcrumb-item v-for="part in selected.path.split('/').slice(0, -1)" :key="part">{{ part }}</el-breadcrumb-item>
						<el-breadcrumb-item>{{ noteName(selected.path) }}</el-breadcrumb-item>
					</el-breadcrumb>
					<div class="editor-actions">
						<el-tag :type="saveStatus === '保存失败' ? 'danger' : saveStatus === '已保存' ? 'success' : 'info'" effect="plain" size="small"><el-icon v-if="saveStatus === '已保存'"><Check /></el-icon> {{ saveStatus }}</el-tag>
						<el-tooltip :content="state.favorites.includes(selected.path) ? '取消收藏' : '收藏笔记'">
							<el-button class="note-favorite-button" :class="{ 'is-favorited': state.favorites.includes(selected.path) }" text :icon="state.favorites.includes(selected.path) ? StarFilled : Star" @click="favorite" :aria-label="state.favorites.includes(selected.path) ? '取消收藏' : '收藏笔记'" :aria-pressed="state.favorites.includes(selected.path)" />
						</el-tooltip>
						<el-button :icon="Share" :disabled="selected.protected" :title="selected.protected ? '加锁内容不能分享' : '分享笔记'" @click="openShare">分享</el-button>
						<el-dropdown trigger="click" @command="(cmd) => resourceCommand(cmd, selected.path)">
							<el-button text :icon="MoreFilled" aria-label="笔记操作" />
							<template #dropdown>
								<el-dropdown-menu>
									<el-dropdown-item v-for="item in noteMenuItems(selected)" :key="item.command" :command="item.command" :icon="item.icon" :disabled="item.disabled" :divided="item.divided" :class="{ 'folder-menu-danger': item.danger, 'note-favorite-menu-active': item.favorited }">{{ item.label }}</el-dropdown-item>
								</el-dropdown-menu>
							</template>
						</el-dropdown>
					</div>
				</header>
				<div class="note-title-row">
					<div>
						<el-input class="note-title-input" :model-value="title" :disabled="uploading" aria-label="笔记标题" placeholder="输入笔记标题" @update:model-value="updateTitle" @blur="act(flush)" @keydown.enter.prevent="act(flush)" />
						<p>{{ selected.path }} <span>·</span> {{ new Date(selected.modified).toLocaleString() }}</p>
					</div>
					<el-button type="primary" plain :icon="Paperclip" @click="attachmentDialog = true">附件 <el-badge v-if="attachments.length" :value="attachments.length" type="primary" /></el-button>
				</div>
				<div class="view-toolbar">
					<el-radio-group v-model="mode" size="small">
						<el-radio-button value="edit">编辑</el-radio-button>
						<el-radio-button v-if="!isMobile" value="split">编辑与预览</el-radio-button>
						<el-radio-button value="preview">阅读</el-radio-button>
					</el-radio-group>
					<div>
						<el-upload :show-file-list="false" :http-request="uploadRequest" multiple :disabled="uploading">
							<el-button text :icon="UploadFilled" :loading="uploading">上传附件</el-button>
						</el-upload>
						<el-button text :icon="Check" @click="manualSave">保存</el-button>
					</div>
				</div>
				<div class="markdown-area" @dragover.prevent @drop.capture="dropFiles">
					<MdEditor :theme="editorTheme" v-if="mode !== 'preview'" :key="editorSession" ref="editor" :model-value="content" @update:model-value="updateContent" @on-upload-img="uploadImages" @on-save="manualSave" :toolbars="isMobile ? mobileToolbars : toolbars" :preview="mode === 'split'" :sanitize="sanitize" :footers="[]" code-theme="github" preview-theme="github" no-mermaid no-katex no-echarts no-prettier no-img-zoom-in :show-code-row-number="true" placeholder="写下你的想法，支持 Markdown、图片和附件…" />
					<MdPreview :theme="editorTheme" v-else :model-value="content" :sanitize="sanitize" code-theme="github" preview-theme="github" no-mermaid no-katex no-echarts />
				</div>
				<div v-if="uploading" class="inline-upload">
					<el-icon><UploadFilled /></el-icon>
					<span>正在上传附件…</span>
					<el-progress :percentage="jobs.filter((j) => j.status === 'uploading')[0]?.progress || 0" :stroke-width="4" />
				</div>
				<footer class="editor-footer">
					<span><i></i> 自动保存已开启 <span class="footer-divider">|</span> Markdown</span>
					<span>{{ attachments.length }} 个附件 <span class="footer-divider">|</span> {{ content.length }} 字符 <template v-if="!isMobile"><span class="footer-divider">|</span> Ctrl / ⌘ + S 保存</template></span>
				</footer>
			</template>
			<section v-else-if="selectedTrash && !lockView" class="trash-preview">
				<header class="trash-preview-header">
					<div>
						<h2>{{ noteName(selectedTrash.path) }}</h2>
						<p>{{ selectedTrash.path }} · 回收站内容，仅供预览</p>
					</div>
					<div>
						<el-button :disabled="trashBatchBusy" @click="trashAction(selectedTrash)">恢复</el-button>
						<el-button type="danger" plain :disabled="trashBatchBusy" @click="trashAction(selectedTrash, true)">永久删除</el-button>
					</div>
				</header>
				<el-scrollbar class="trash-preview-body">
					<template v-if="selectedTrash.type === 'folder'">
						<p>文件夹内容</p>
						<div v-for="entry in selectedTrash.entries" :key="entry.path" class="trash-preview-entry">
							<el-icon><Folder v-if="entry.type === 'folder'" /> <Document v-else /></el-icon>
							{{ entry.path }}
						</div>
						<el-empty v-if="!selectedTrash.entries.length" description="文件夹为空" :image-size="60" />
					</template>
					<MdPreview :theme="editorTheme" v-else editor-id="trash-preview" :model-value="selectedTrash.content" :sanitize="sanitize" code-theme="github" preview-theme="github" no-mermaid no-katex no-echarts />
				</el-scrollbar>
			</section>
			<section v-else-if="lockView && !folderUnlock" class="reading-lock-panel" aria-label="阅读密码解锁">
				<div class="reading-lock-context">{{ lockView.path.startsWith("@trash/") ? "回收站中的加锁内容" : lockView.path }}</div>
				<el-form @keydown="submitFormOnEnter" class="reading-lock-form" @submit.prevent="submitUnlock">
					<el-icon class="reading-lock-icon"><Lock /></el-icon>
					<p>输入阅读密码解锁 {{ lockView.type === "folder" ? "文件夹" : "笔记" }}</p>
					<el-input v-model="lockPassword" type="password" show-password autocomplete="off" aria-label="阅读密码" placeholder="请输入阅读密码" :disabled="unlockBusy" />
					<el-alert v-if="unlockError" :title="unlockError" type="error" :closable="false" class="lock-feedback" />
					<el-button class="reading-unlock-button" type="primary" native-type="submit" :loading="unlockBusy">解锁</el-button>
					<div class="reading-lock-links">
						<el-button link :disabled="unlockBusy" @click="cancelReadingLock">取消阅读密码</el-button>
						<span></span>
						<el-button link :disabled="unlockBusy" @click="configureReadingPassword(true)">{{ state.user?.accessPasswordConfigured ? "忘记密码" : "设置阅读密码" }}</el-button>
					</div>
				</el-form>
			</section>
		</main>
	</div>
	<ContextMenu v-if="contextMenu" :key="contextMenu.id" :x="contextMenu.x" :y="contextMenu.y" :items="contextItems" @select="contextCommand" @close="contextMenu = null" />
	<el-dialog v-model="itemDialog" :title="itemForm.from ? '重命名与移动' : itemForm.kind === 'note' ? '新建笔记' : '新建文件夹'" width="460px" :close-on-click-modal="!itemBusy">
		<el-form @keydown="submitFormOnEnter" id="note-item-form" label-position="top" :disabled="itemBusy" @submit.prevent="submitItem">
			<el-form-item :label="itemForm.kind === 'note' ? '笔记名称' : '文件夹名称'">
				<el-input v-model="itemForm.name" placeholder="请输入名称" autofocus>
					<template #suffix>
						<span v-if="itemForm.kind === 'note'">.md</span>
					</template>
				</el-input>
			</el-form-item>
			<el-form-item label="保存位置">
				<el-select v-model="itemForm.parent" :empty-values="[null, undefined]" style="width: 100%">
					<el-option label="根目录" value="" />
					<el-option v-for="f in destinations" :key="f.path" :label="f.path" :value="f.path" />
				</el-select>
			</el-form-item>
		</el-form>
		<el-alert v-if="error" :title="error" type="error" :closable="false" />
		<template #footer>
			<el-button @click="itemDialog = false">取消</el-button>
			<el-button type="primary" :loading="itemBusy" native-type="submit" form="note-item-form">{{ itemForm.from ? "保存更改" : "创建" }}</el-button>
		</template>
	</el-dialog>
	<el-dialog v-model="attachmentDialog" title="笔记附件" width="640px" :close-on-click-modal="!uploading">
		<el-upload drag multiple :http-request="uploadRequest" :show-file-list="false" :disabled="uploading">
			<el-icon class="el-icon--upload"><UploadFilled /></el-icon>
			<div class="el-upload__text">
				拖拽图片或文件到这里，或
				<em>点击上传</em>
			</div>
			<template #tip>
				<div class="el-upload__tip">每个文件最大 500MB。上传后自动插入当前笔记并保存到 NAS。</div>
			</template>
		</el-upload>
		<div class="upload-jobs" v-if="jobs.length">
			<div v-for="job in jobs" :key="job.id" class="upload-job">
				<el-icon><Document /></el-icon>
				<div>
					<strong>{{ job.name }} <small>{{ formatSize(job.size) }}</small></strong>
					<el-progress v-if="job.status === 'uploading'" :percentage="job.progress" :stroke-width="4" />
					<small class="upload-error" v-else-if="job.status === 'error'">{{ job.error }} ，请重新选择文件上传。</small>
				</div>
				<el-tag v-if="job.status === 'success'" type="success" size="small">已上传</el-tag>
			</div>
		</div>
		<h3 class="attachment-heading">
			当前笔记引用的附件
			<el-tag size="small" type="info">{{ attachments.length }}</el-tag>
		</h3>
		<el-empty v-if="!attachments.length" :image-size="55" description="还没有附件" />
		<div v-for="asset in attachments" :key="asset.url" class="attachment-row">
			<img v-if="asset.image" :src="asset.url" :alt="asset.name" />
			<div v-else class="attachment-file-icon">
				<el-icon><Document /></el-icon>
			</div>
			<div>
				<strong>{{ asset.name }}</strong>
				<small>{{ asset.image ? "图片" : "文件" }} {{ formatSize(asset.size) }}</small>
			</div>
			<el-button tag="a" :href="asset.url + '?download=1'" :icon="Download" target="_blank" rel="noopener">下载</el-button>
		</div>
	</el-dialog>
	<el-dialog v-model="shareDialog" title="私密分享" width="480px">
		<el-alert title="仅分享当前笔记和它引用的附件，访问者只能阅读。" type="info" :closable="false" show-icon />
		<el-form @keydown="submitFormOnEnter" id="note-share-form" label-position="top" class="dialog-form" :disabled="shareBusy" @submit.prevent="share">
			<el-form-item label="有效期">
				<div class="share-expiry-field">
					<div class="share-expiry-custom">
						<el-input-number v-model="shareHours" :min="0" :max="8760" :precision="0" />
						<span class="unit-label">{{ shareHours === 0 ? "长期有效" : "小时" }}</span>
					</div>
					<div class="share-expiry-shortcuts">
						<el-button v-for="option in shareExpiryOptions" :key="option.hours" size="small" :type="shareHours === option.hours ? 'primary' : 'default'" :plain="shareHours !== option.hours" @click="shareHours = option.hours">{{ option.label }}</el-button>
					</div>
					<span class="share-expiry-hint">默认 24 小时，可自定义；0 表示长期，1 个月按 30 天计算。</span>
				</div>
			</el-form-item>
			<el-form-item label="访问密码（可选）">
				<el-input v-model="sharePassword" type="password" show-password placeholder="留空则凭链接访问" />
			</el-form-item>
		</el-form>
		<el-button type="primary" :loading="shareBusy" native-type="submit" form="note-share-form">生成分享链接</el-button>
		<div v-if="shareLink" class="share-result">
			<el-input :model-value="shareLink" readonly @focus="$event.target.select()" />
			<el-button :icon="CopyDocument" @click="copyLink">复制</el-button>
		</div>
		<p class="dialog-hint">外网分享需要 NAS 已配置可访问的网络入口。</p>
	</el-dialog>
	<el-dialog v-model="settings" title="设置与数据安全" width="680px">
		<div class="theme-settings">
			<span>外观</span>
			<el-radio-group v-model="themePreference" size="small" aria-label="外观模式">
				<el-radio-button value="light">浅色</el-radio-button>
				<el-radio-button value="dark">深色</el-radio-button>
				<el-radio-button value="system">跟随系统</el-radio-button>
			</el-radio-group>
		</div>
		<el-descriptions :column="1" :label-width="isMobile ? 86 : 120" border>
			<el-descriptions-item label="数据保存目录">
				<code>{{ state.dataDir }}</code>
			</el-descriptions-item>
			<el-descriptions-item label="文件存储">标准 Markdown 文件 · 附件保存在本地</el-descriptions-item>
			<el-descriptions-item label="账号与分享">SQLite 持久化存储</el-descriptions-item>
		</el-descriptions>
		<p class="dialog-hint">数据目录通过 NOTESPACE_DATA_DIR 配置。切换目录前，请停机复制数据并确认读写权限。</p>
		<div class="backup-box">
			<div>
				<strong>完整备份</strong>
				<p>备份笔记、附件、回收站与应用设置。</p>
			</div>
			<el-button type="primary" :loading="backupBusy" @click="backup">立即备份</el-button>
		</div>
		<el-divider content-position="left">登录密码</el-divider>
		<p class="account-caption">修改登录密码后，需要重新登录。</p>
		<el-button @click="openPasswordDialog">修改登录密码</el-button>
		<el-divider content-position="left">账号阅读密码</el-divider>
		<p class="lock-description">{{ state.user?.accessPasswordConfigured ? "已设置，所有加锁笔记和文件夹共用。" : "尚未设置，首次加锁时设置一次即可。" }}</p>
		<el-button @click="configureReadingPassword(false)">{{ state.user?.accessPasswordConfigured ? "修改阅读密码" : "设置阅读密码" }}</el-button>
		<el-button v-if="state.user?.accessPasswordConfigured" link type="primary" @click="configureReadingPassword(true)">忘记阅读密码</el-button>
	</el-dialog>
	<ShareManagement v-if="ready" v-model="shareManagementOpen" @changed="act(load)" />
	<el-dialog align-center v-model="passwordDialog" title="修改登录密码" width="440px" :close-on-click-modal="false" :close-on-press-escape="!passwordBusy" :show-close="!passwordBusy" @closed="passwordForm = { current: '', next: '', confirm: '' }; passwordError = ''">
		<p class="lock-description">修改后，当前笔记空间的所有登录会话将失效，请使用新密码重新登录。</p>
		<el-form @keydown="submitFormOnEnter" id="login-password-form" label-position="top" :disabled="passwordBusy" @submit.prevent="changePassword">
			<el-form-item label="当前登录密码">
				<el-input v-model="passwordForm.current" type="password" show-password autocomplete="current-password" maxlength="20" />
			</el-form-item>
			<el-form-item label="新登录密码（6 至 20 位）">
				<el-input v-model="passwordForm.next" type="password" show-password autocomplete="new-password" maxlength="20" />
			</el-form-item>
			<el-form-item label="再次输入新登录密码">
				<el-input v-model="passwordForm.confirm" type="password" show-password autocomplete="new-password" maxlength="20" />
			</el-form-item>
			<el-alert v-if="passwordError" :title="passwordError" type="error" :closable="false" />
		</el-form>
		<template #footer>
			<el-button :disabled="passwordBusy" @click="passwordDialog = false">取消</el-button>
			<el-button type="primary" :loading="passwordBusy" native-type="submit" form="login-password-form">保存登录密码</el-button>
		</template>
	</el-dialog>
	<el-dialog align-center v-model="lockDialog" :title="!state.user?.accessPasswordConfigured ? '设置账号阅读密码' : readingReset ? '重设账号阅读密码' : '修改账号阅读密码'" width="440px" :close-on-click-modal="false" :show-close="!lockBusy">
		<p class="lock-description">阅读密码绑定当前账号，所有加锁笔记和文件夹共用这一份密码。 {{ lockTarget ? "保存后会为选中的内容加锁。" : "" }}</p>
		<el-form @keydown="submitFormOnEnter" id="reading-password-form" label-position="top" :disabled="lockBusy" @submit.prevent="submitLock">
			<el-form-item v-if="state.user?.accessPasswordConfigured && readingReset" label="验证登录密码">
				<el-input v-model="lockForm.login" type="password" show-password autocomplete="current-password" placeholder="请输入登录密码" />
			</el-form-item>
			<el-form-item v-else-if="state.user?.accessPasswordConfigured" label="当前阅读密码">
				<el-input v-model="lockForm.current" type="password" show-password autocomplete="off" />
			</el-form-item>
			<el-form-item label="阅读密码（6 至 20 位）">
				<el-input v-model="lockForm.password" maxlength="20" type="password" show-password autocomplete="new-password" />
			</el-form-item>
			<el-form-item label="再次输入阅读密码">
				<el-input v-model="lockForm.confirm" maxlength="20" type="password" show-password autocomplete="new-password" />
			</el-form-item>
			<el-alert v-if="readingError" :title="readingError" type="error" :closable="false" />
		</el-form>
		<template #footer>
			<el-button :disabled="lockBusy" @click="lockDialog = false">取消</el-button>
			<el-button type="primary" :loading="lockBusy" native-type="submit" form="reading-password-form">保存阅读密码</el-button>
		</template>
	</el-dialog>
	<el-dialog v-model="historyDialog" title="正文版本" top="6vh" width="900px" class="history-dialog">
		<div class="history-caption">
			<span>保留最近 50 份正文，自动记录最多每分钟一次。</span>
			<el-button @click="act(snapshotVersion)" :disabled="historyBusy">记录当前正文</el-button>
		</div>
		<div class="history-layout">
			<div class="history-list">
				<el-empty v-if="!history.length" description="暂无历史版本" :image-size="60" />
				<button v-for="version in history" :key="version.id" class="version-item" :class="{ active: historyPreview?.id === version.id }" @click="act(() => previewVersion(version))"><strong>{{ new Date(version.created).toLocaleString() }}</strong> <span>{{ version.reason }} · {{ version.characters }} 字符</span></button>
			</div>
			<div class="history-content" v-loading="historyBusy">
				<MdPreview :theme="editorTheme" v-if="historyPreview" editor-id="history-preview" :model-value="historyPreview.content" :sanitize="sanitize" />
				<el-empty v-else description="选择版本查看正文" :image-size="80" />
			</div>
		</div>
		<template #footer>
			<el-button @click="historyDialog = false">关闭</el-button>
			<el-button type="primary" :disabled="!historyPreview || historyBusy" @click="act(restoreVersion)">恢复此版本</el-button>
		</template>
	</el-dialog>
</template>
