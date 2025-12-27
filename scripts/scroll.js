// Scroll to top button functionality
const scrollBtn = document.getElementById("btn-scroll-top");

window.addEventListener("scroll", () => {
  if (window.pageYOffset > 300) {
    scrollBtn.classList.add("visible");
  } else {
    scrollBtn.classList.remove("visible");
  }
});

scrollBtn.addEventListener("click", () => {
  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });

  gtag("event", "scroll_top", {
    event_category: "navegacion",
  });
});
