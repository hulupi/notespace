<script setup>
import { defineAsyncComponent } from "vue";
import { resolvePage } from "./router/index.js";

const page = resolvePage();
const view = defineAsyncComponent(page.load);
</script>

<template>
	<component :is="view" v-bind="page.props" />
</template>
