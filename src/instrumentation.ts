export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Sessions are signed with the password and a server secret together. With no BROADSIDE_SECRET set, the
    // install's own key file supplies one, so a leaked cookie never reduces to guessing the password alone.
    if (!process.env.BROADSIDE_SECRET) {
      const { installSecret } = await import("./lib/crypto");
      process.env.BROADSIDE_SESSION_SECRET = installSecret();
    }
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  }
}
