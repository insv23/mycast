export {};

const path = location.pathname.replace(/\/+$/, "") || "/";

if (path === "/launcher") {
  await import("./launcher");
} else {
  await import("./main");
}
