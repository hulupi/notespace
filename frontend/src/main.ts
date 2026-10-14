import { createApp } from "vue";
import App from "./App.vue";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import "./stores/theme.js";
import "md-editor-v3/lib/style.css";
import "highlight.js/styles/github.css";
import hljs from "highlight.js/lib/common";
import { config } from "md-editor-v3";
import "./styles/app.css";
import logoUrl from "./assets/logo.js";
const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') || document.createElement("link");
favicon.rel = "icon";
favicon.type = "image/png";
favicon.href = logoUrl;
if (!favicon.isConnected) document.head.appendChild(favicon);
config({
  editorExtensions: {
    highlight: { instance: hljs, css: { github: { light: "", dark: "" } } },
  },
});
createApp(App).use(ElementPlus, { locale: zhCn }).mount("#app");
