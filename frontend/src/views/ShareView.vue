<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import { Lock, Moon, Sunny } from "@element-plus/icons-vue";
import { isDark, editorTheme, toggleTheme } from "../stores/theme.js";
import logoUrl from "../assets/logo.js";
import { MdPreview } from "md-editor-v3";
import { sanitizeMarkdown as sanitize } from "../utils/sanitize.js";
import { api } from "../api/client.js";
import { submitFormOnEnter } from "../utils/form-submit.js";

const props = defineProps({ token: { type: String, required: true } });
const appBase = import.meta.env.BASE_URL.replace(/\/$/, "");
const loading = ref(true), busy = ref(false), password = ref(""), error = ref("");
const note = ref(null), content = ref(""), needsPassword = ref(false), unavailable = ref(false);
let blobs = [], requestId = 0, controller;
function releaseBlobs() {
  for (const url of blobs) URL.revokeObjectURL(url);
  blobs = [];
}
async function readShare() {
  if (busy.value) return;
  const current = ++requestId;
  const created = [];
  busy.value = true;
  error.value = "";
  controller = new AbortController();
  try {
    if (!/^[a-f0-9]{48}$/.test(props.token)) throw Object.assign(Error("分享链接无效"), { status: 404 });
    const shared = await api(`/public/${props.token}`, "GET", undefined, { "X-Share-Password": password.value });
    let text = shared.content;
    const names = new Set((text.match(/\/api\/attachments\/[a-f0-9-]+\.[a-z0-9]+/gi) || []).map((url) => url.split("/").at(-1)));
    for (const name of names) {
      const response = await fetch(`${appBase}/api/public/${props.token}/attachment?name=${encodeURIComponent(name)}`, {
        headers: { "X-Share-Password": password.value }, signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw Object.assign(Error(detail.error || "无法读取分享附件"), { status: response.status });
      }
      const url = URL.createObjectURL(await response.blob());
      created.push(url);
      text = text.replaceAll(`${appBase}/api/attachments/${name}`, url).replaceAll(`/api/attachments/${name}`, url);
    }
    if (current !== requestId) { created.forEach(URL.revokeObjectURL); return; }
    releaseBlobs();
    blobs = created;
    note.value = shared;
    content.value = text;
    needsPassword.value = false;
  } catch (failure) {
    created.forEach(URL.revokeObjectURL);
    if (current !== requestId || failure.name === "AbortError") return;
    needsPassword.value = failure.status === 401;
    unavailable.value = [403, 404].includes(failure.status);
    error.value = failure.status === 401 && !password.value ? "" : failure.message;
  } finally {
    if (current === requestId) { loading.value = false; busy.value = false; }
  }
}
onMounted(() => {
  document.documentElement.classList.add("share-view-open");
  readShare();
});
onBeforeUnmount(() => {
  document.documentElement.classList.remove("share-view-open");
  ++requestId;
  controller?.abort();
  releaseBlobs();
});
</script>

<template>
	<div class="share-screen" :class="{ 'share-dark': isDark }">
		<main class="public-page" v-loading="loading">
			<header class="public-header">
				<div class="brand-mark">
					<img :src="logoUrl" alt="知间笔记 Logo" />
				</div>
				<strong>知间笔记</strong>
				<span class="share-badge">只读分享</span>
				<el-button text :icon="isDark ? Sunny : Moon" @click="toggleTheme" :aria-label="isDark ? '切换浅色模式' : '切换深色模式'" />
			</header>
			<template v-if="!loading">
				<template v-if="note"><h1 class="shared-note-title">{{ note.path.split('/').at(-1).replace(/\.md$/i, '') }}</h1> <MdPreview :theme="editorTheme" editor-id="shared-note" :model-value="content" :sanitize="sanitize" code-theme="github" preview-theme="github" no-mermaid no-katex no-echarts /></template>
				<section v-else-if="needsPassword" class="share-login" aria-label="分享密码验证">
					<el-icon class="share-lock"><Lock /></el-icon>
					<h2>这是一份私密分享</h2>
					<p>输入分享密码后，即可查看笔记。</p>
					<el-form @keydown="submitFormOnEnter" @submit.prevent="readShare">
						<el-form-item>
							<el-input v-model="password" size="large" type="password" show-password autocomplete="off" placeholder="请输入分享密码" :disabled="busy" autofocus />
						</el-form-item>
						<el-button class="share-submit" size="large" type="primary" native-type="submit" :loading="busy">查看笔记</el-button>
					</el-form>
					<el-alert v-if="error" :title="error" type="error" :closable="false" />
				</section>
				<el-result v-else :icon="unavailable ? 'info' : 'error'" :title="unavailable ? '分享已失效' : '暂时无法打开分享'" :sub-title="error">
					<template #extra>
						<el-button v-if="!unavailable" :loading="busy" @click="readShare">重新加载</el-button>
					</template>
				</el-result>
			</template>
		</main>
	</div>
</template>

<style scoped>
:global(html.share-view-open), :global(html.share-view-open body) { background: #fff; }
.share-screen {
  --share-background: #fff;
  --share-text: #242a31;
  --share-muted: #8a9199;
  --share-border: #eceef0;
  --share-surface: #f5f7f9;
  --share-code-background: #f5f7f9;
  --share-link: #377d64;
  --el-mask-color: rgba(255, 255, 255, .85);
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--share-background);
  color: var(--share-text);
}
.share-screen.share-dark {
  --share-background: #171c20;
  --share-text: #dce5df;
  --share-muted: #9caaa3;
  --share-border: #344139;
  --share-surface: #222b30;
  --share-code-background: #1d252b;
  --share-link: #83c8a8;
  --el-mask-color: rgba(23, 28, 32, .85);
}
.public-page { max-width: 900px; min-height: 100vh; min-height: 100dvh; margin: 0 auto; padding: 32px 40px 72px; background: transparent; }
.public-header { padding-bottom: 22px; margin-bottom: 0; border-bottom: 1px solid var(--share-border); gap: 10px; }
.public-header .brand-mark { width: 40px; height: 40px; background: transparent; color: #377d64; font-size: 25px; }
.public-header strong { font-size: 15px; font-weight: 600; letter-spacing: .3px; }
.share-badge { margin-left: auto; color: var(--share-muted); font-size: 12px; }
.shared-note-title { margin: 34px 0 18px; font-size: 30px; font-weight: 600; line-height: 1.5; letter-spacing: -.4px; overflow-wrap: anywhere; }
.share-login { max-width: 360px; margin: 100px auto 0; padding: 0; background: transparent; border: 0; box-shadow: none; text-align: center; }
.share-login h2 { margin: 16px 0 10px; color: var(--share-text); font-size: 23px; font-weight: 600; }
.share-login p { margin-bottom: 30px; color: var(--share-muted); font-size: 14px; line-height: 1.7; }
.share-lock { font-size: 32px; color: #a4adb8; margin-bottom: 0; }
.share-submit { width: 100%; }
.share-login .el-alert { margin-top: 16px; }
.public-page :deep(.md-editor) {
  --md-bk-color: transparent;
  --md-color: var(--share-text);
  --md-border-color: var(--share-border);
  --md-theme-color: var(--share-link);
  --md-hover-color: var(--share-link);
  border: 0;
  background: transparent;
  color: var(--share-text);
}
.public-page :deep(.md-editor-preview-wrapper) { padding: 8px 0 0 !important; background: transparent; }
.public-page :deep(.md-editor-preview) { background: transparent; }
:global(html.dark.share-view-open), :global(html.dark.share-view-open body) { background: #171c20; }
.share-dark .shared-note-title,
.share-dark .public-header strong,
.share-dark :deep(.md-editor-preview),
.share-dark :deep(.md-editor-preview :is(h1, h2, h3, h4, h5, h6, strong, em, th, td)) { color: var(--share-text); }
.share-dark :deep(.md-editor-preview a) { color: var(--share-link); }
.share-dark :deep(.md-editor-preview :is(h1, h2, hr, table, th, td)) { border-color: var(--share-border); }
.share-dark :deep(.md-editor-preview blockquote) {
  background: var(--share-surface);
  color: var(--share-muted);
  border-left-color: var(--share-link);
}
.share-dark :deep(.md-editor-preview :is(tr, th)) { background: transparent; }
.share-dark :deep(.md-editor-preview tr:nth-child(2n)) { background: var(--share-surface); }
.share-dark :deep(.md-editor-preview :not(pre) > code) {
  background: var(--share-surface);
  color: #9fd9bb;
}
.share-dark :deep(.md-editor-preview :is(pre, pre code, .md-editor-code-head)) { background: var(--share-code-background); }
.share-dark :deep(.md-editor-code-head :is(span, button, svg)) { color: var(--share-muted); }
.share-dark :deep(.md-editor-code-head button:hover) { color: var(--share-text); }
.share-dark :deep(.el-input__wrapper) { background: var(--share-surface); }
.share-dark :deep(.el-result__title p) { color: var(--share-text); }
.share-dark :deep(.el-result__subtitle p) { color: var(--share-muted); }
@media (max-width: 800px) {
  .public-page { padding: 24px 22px 48px; }
  .shared-note-title { margin: 26px 0 14px; font-size: 24px; }
  .share-login { margin-top: 72px; }
  .share-login h2 { font-size: 21px; }
}
</style>
