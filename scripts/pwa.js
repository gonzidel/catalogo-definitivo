// PWA installation functionality
let deferredPrompt;
const installModal = document.getElementById("install-modal");
const installAccept = document.getElementById("install-accept");
const installLater = document.getElementById("install-later");

// Show install prompt when available
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;

  // Show modal after 5 seconds
  setTimeout(() => {
    if (deferredPrompt) {
      installModal.classList.remove("hidden");
    }
  }, 5000);
});

// Handle install button click
installAccept.addEventListener("click", async () => {
  if (!deferredPrompt) return;

  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;

  gtag("event", "pwa_install", {
    event_category: "instalacion",
    event_label: outcome,
  });

  deferredPrompt = null;
  installModal.classList.add("hidden");
});

// Handle later button click
installLater.addEventListener("click", () => {
  installModal.classList.add("hidden");

  gtag("event", "pwa_install_later", {
    event_category: "instalacion",
  });
});

// Handle successful installation
window.addEventListener("appinstalled", () => {
  gtag("event", "pwa_installed", {
    event_category: "instalacion",
  });
});
