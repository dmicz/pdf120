// Runs at document_start in every top-level document. Chrome renders PDFs in
// a synthesized document whose contentType is "application/pdf"; when we see
// one, stop Chrome's viewer from loading and ask the background to swap in ours.
// For file:// URLs this needs "Allow access to file URLs" on the extension.
if (window.top === window && document.contentType === "application/pdf") {
  const url = location.href;
  chrome.runtime.sendMessage({ type: "pdf-detected", url }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res?.redirect) window.stop();
  });
}
