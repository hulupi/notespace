import { computed, ref, watch } from "vue";

const preferenceKey = "notespace:theme";
const system = window.matchMedia("(prefers-color-scheme: dark)");
let saved;
try { saved = localStorage.getItem(preferenceKey); } catch {}
export const themePreference = ref(["light", "dark", "system"].includes(saved) ? saved : "system");
const systemDark = ref(system.matches);
export const isDark = computed(() => themePreference.value === "dark" || (themePreference.value === "system" && systemDark.value));
export const editorTheme = computed(() => isDark.value ? "dark" : "light");
system.addEventListener("change", (event) => { systemDark.value = event.matches; });
watch(isDark, (dark) => {
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}, { immediate: true, flush: "sync" });
watch(themePreference, (value) => {
  try { localStorage.setItem(preferenceKey, value); } catch {}
});
export function toggleTheme() {
  themePreference.value = isDark.value ? "light" : "dark";
}
