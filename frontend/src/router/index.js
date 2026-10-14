// Keep the existing lightweight page selection and lazy loading.
export function resolvePage(pathname = window.location.pathname) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const sharePrefix = base + "/s/";
  if (pathname.startsWith(sharePrefix)) {
    return {
      load: () => import("../views/ShareView.vue"),
      props: { token: pathname.slice(sharePrefix.length).split("/")[0] },
    };
  }
  return { load: () => import("../views/WorkspaceView.vue"), props: {} };
}
