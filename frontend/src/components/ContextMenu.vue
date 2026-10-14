<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";

const props = defineProps({
	items: { type: Array, required: true },
	x: { type: Number, required: true },
	y: { type: Number, required: true },
});
const emit = defineEmits(["select", "close"]);
const menu = ref(null), width = ref(208), height = ref(0);
const position = computed(() => ({
	left: Math.max(8, Math.min(props.x, window.innerWidth - width.value - 8)) + "px",
	top: Math.max(8, Math.min(props.y, window.innerHeight - height.value - 8)) + "px",
}));
function closeOutside(event) {
	if (!menu.value?.contains(event.target)) emit("close");
}
function close() { emit("close"); }
function keydown(event) {
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		emit("close");
		return;
	}
	if (event.key === "Tab") return emit("close");
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
	event.preventDefault();
	const buttons = [...menu.value.querySelectorAll("button:not(:disabled)")];
	if (!buttons.length) return;
	const current = buttons.indexOf(document.activeElement);
	const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
	buttons[index].focus();
}
onMounted(async () => {
	document.addEventListener("pointerdown", closeOutside, true);
	window.addEventListener("resize", close);
	window.addEventListener("blur", close);
	document.addEventListener("scroll", closeOutside, true);
	await nextTick();
	if (!menu.value) return;
	width.value = menu.value.offsetWidth;
	height.value = menu.value.offsetHeight;
	menu.value.querySelector("button:not(:disabled)")?.focus();
});
onBeforeUnmount(() => {
	document.removeEventListener("pointerdown", closeOutside, true);
	window.removeEventListener("resize", close);
	window.removeEventListener("blur", close);
	document.removeEventListener("scroll", closeOutside, true);
});
</script>

<template>
	<Teleport to="body">
		<div ref="menu" class="resource-context-menu" :style="position" role="menu" aria-label="内容操作" @contextmenu.prevent @keydown="keydown">
			<template v-for="item in items" :key="item.command">
				<div v-if="item.divided" class="resource-context-divider" role="separator">
				</div>
				<button type="button" class="resource-context-item" :class="{ danger: item.danger, favorited: item.favorited }" :disabled="item.disabled" role="menuitem" @click="emit('select', item.command)"><el-icon><component :is="item.icon" /></el-icon> <span>{{ item.label }}</span></button>
			</template>
		</div>
	</Teleport>
</template>

<style scoped>
.resource-context-menu {
  position: fixed;
  z-index: 4000;
  width: 208px;
  max-width: calc(100vw - 16px);
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color-overlay, #fff);
  box-shadow: var(--el-box-shadow-light, 0 8px 28px #0002);
  color: var(--el-text-color-primary);
}
.resource-context-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  text-align: left;
  font-size: 13px;
  cursor: pointer;
}
.resource-context-item:hover,
.resource-context-item:focus-visible { background: var(--el-fill-color-light); }
.resource-context-item.danger { color: var(--el-color-danger); }
.resource-context-item.favorited:not(:disabled) > .el-icon { color: #bba766; }
.resource-context-item:disabled { color: var(--el-text-color-placeholder); cursor: not-allowed; background: transparent; }
.resource-context-divider { height: 1px; margin: 5px 0; background: var(--el-border-color-light); }
</style>
