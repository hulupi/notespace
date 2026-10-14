<script setup>
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { CopyDocument, Link, Delete, Refresh, View, Hide } from "@element-plus/icons-vue";
import { api } from "../api/client.js";

const props = defineProps({ modelValue: Boolean });
const emit = defineEmits(["update:modelValue", "changed"]);
const visible = computed({ get: () => props.modelValue, set: (value) => emit("update:modelValue", value) });
const rows = ref([]), loading = ref(false), error = ref(""), now = ref(Date.now());
const revealed = ref(new Set()), revoking = ref(new Set());
const appBase = import.meta.env.BASE_URL.replace(/\/$/, "");
let timer, requestId = 0;
const title = (row) => row.path.split("/").at(-1).replace(/\.md$/i, "");
const shareUrl = (row) => `${location.origin}${appBase}/s/${row.token}`;
const expired = (row) => row.expires !== 0 && row.expires <= now.value;
function remaining(row) {
  if (row.expires === 0) return "长期有效";
  const seconds = Math.ceil((row.expires - now.value) / 1000);
  if (seconds <= 0) return "已过期";
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes) return `${minutes} 分钟`;
  return `${seconds} 秒`;
}
async function load() {
  const current = ++requestId;
  loading.value = true;
  error.value = "";
  try {
    const result = await api("/shares");
    if (current !== requestId) return;
    rows.value = result.shares.sort((a, b) => (b.expires === 0 ? Infinity : b.expires) - (a.expires === 0 ? Infinity : a.expires));
    now.value = Date.now();
    revealed.value = new Set();
  } catch (failure) {
    if (current !== requestId) return;
    rows.value = [];
    error.value = failure.message;
  } finally { if (current === requestId) loading.value = false; }
}
function togglePassword(token) {
  const next = new Set(revealed.value);
  if (next.has(token)) next.delete(token); else next.add(token);
  revealed.value = next;
}
async function copyLink(row) {
  try {
    const value = shareUrl(row);
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); copied = true; } catch { /* Fall back for ordinary HTTP NAS pages. */ }
    }
    if (!copied) {
      const input = document.createElement("textarea");
      const focused = document.activeElement;
      input.value = value;
      input.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(input);
      try { input.focus(); input.select(); copied = document.execCommand("copy"); }
      finally { input.remove(); focused?.focus(); }
    }
    if (copied) ElMessage.success("分享链接已复制");
    else ElMessage.info("请选中分享链接手动复制");
  } catch (failure) { ElMessage.error(failure.message || "复制失败，请手动复制链接"); }
}
async function revoke(row) {
  try {
    await ElMessageBox.confirm(`撤销“${title(row)}”的分享后，原链接将无法访问。`, "撤销分享", { type: "warning", confirmButtonText: "撤销分享", cancelButtonText: "取消" });
    revoking.value = new Set([...revoking.value, row.token]);
    await api("/revoke", "POST", { token: row.token });
    rows.value = rows.value.filter((item) => item.token !== row.token);
    ElMessage.success("分享已撤销");
    emit("changed");
  } catch (failure) {
    if (failure !== "cancel" && failure !== "close") ElMessage.error(failure.message || "撤销失败");
  } finally {
    const next = new Set(revoking.value); next.delete(row.token); revoking.value = next;
  }
}
watch(visible, (open) => {
  clearInterval(timer);
  if (open) {
    load();
    timer = setInterval(() => { now.value = Date.now(); }, 1000);
  } else {
    ++requestId;
    rows.value = [];
    revealed.value = new Set();
    loading.value = false;
  }
}, { immediate: true });
onBeforeUnmount(() => { ++requestId; clearInterval(timer); });
</script>

<template>
	<el-dialog v-model="visible" title="分享管理" width="1080px" class="share-management-dialog" destroy-on-close>
		<div class="management-toolbar">
			<span>管理当前用户的分享，共 {{ rows.length }} 条</span>
			<el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
		</div>
		<el-alert v-if="error" :title="error" type="error" :closable="false" class="management-error" />
		<el-table :data="rows" v-loading="loading" empty-text="暂无分享，请在笔记中创建分享链接。" max-height="560">
			<el-table-column label="标题" min-width="180">
				<template #default="{ row }">
					<div class="share-note">
						<strong>{{ title(row) }}</strong>
					</div>
				</template>
			</el-table-column>
			<el-table-column label="密码" min-width="150">
				<template #default="{ row }">
					<div v-if="row.password" class="share-password">
						<code>{{ revealed.has(row.token) ? row.password : '••••••' }}</code>
						<el-button text circle :icon="revealed.has(row.token) ? Hide : View" :aria-label="revealed.has(row.token) ? '隐藏分享密码' : '查看分享密码'" @click="togglePassword(row.token)" />
					</div>
					<el-tooltip v-else-if="row.hasPassword" content="旧分享只保存了密码哈希，无法还原。可撤销后重新创建分享。">
						<span class="muted">不可查看</span>
					</el-tooltip>
					<span v-else class="muted">无密码</span>
				</template>
			</el-table-column>
			<el-table-column label="剩余时间" min-width="140">
				<template #default="{ row }">
					<el-tooltip :content="row.expires === 0 ? '长期有效，撤销分享后链接停止访问' : '到期时间：' + new Date(row.expires).toLocaleString()">
						<span :class="{ muted: expired(row) }">{{ remaining(row) }}</span>
					</el-tooltip>
				</template>
			</el-table-column>
			<el-table-column label="分享链接" min-width="250">
				<template #default="{ row }">
					<el-input :model-value="shareUrl(row)" readonly aria-label="分享链接" @focus="$event.target.select()" />
				</template>
			</el-table-column>
			<el-table-column label="操作" width="235" fixed="right">
				<template #default="{ row }">
					<el-button link type="primary" :icon="CopyDocument" @click="copyLink(row)">复制</el-button>
					<el-button link type="primary" :icon="Link" tag="a" :href="shareUrl(row)" target="_blank" rel="noopener noreferrer" :disabled="expired(row)">打开</el-button>
					<el-button link type="danger" :icon="Delete" :loading="revoking.has(row.token)" @click="revoke(row)">撤销</el-button>
				</template>
			</el-table-column>
		</el-table>
	</el-dialog>
</template>

<style scoped>
.management-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; color: #829088; font-size: 13px; }
.management-error { margin-bottom: 16px; }
.share-note { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.share-note strong { font-weight: 500; overflow-wrap: anywhere; }
.share-password { display: flex; align-items: center; gap: 6px; }
.share-password code { overflow-wrap: anywhere; min-width: 0; }
.share-password .el-button { flex-shrink: 0; }
.muted { color: #939e97; }
@media (max-width: 800px) { .management-toolbar { align-items: flex-start; } }
</style>
