fetch("/version.json")
  .then((res) => res.json())
  .then(({ version }) => {
    const badge = document.createElement("div");
    badge.textContent = `v${version}`;
    Object.assign(badge.style, {
      position: "fixed",
      bottom: "8px",
      right: "10px",
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#666",
      background: "rgba(0,0,0,0.3)",
      padding: "2px 6px",
      borderRadius: "4px",
      zIndex: 9999,
      pointerEvents: "none",
    });
    document.body.appendChild(badge);
  })
  .catch(() => {});
