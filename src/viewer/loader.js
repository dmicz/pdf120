// Fetches the PDF bytes. file:// URLs need XHR (fetch() refuses them) and the
// extension's "Allow access to file URLs" toggle.
export async function loadBytes(url) {
  if (url.startsWith("file:")) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.responseType = "arraybuffer";
      xhr.onload = () => (xhr.response && xhr.response.byteLength ? resolve(xhr.response) : reject(new Error(fileAccessHint())));
      xhr.onerror = () => reject(new Error(fileAccessHint()));
      xhr.send();
    });
  }
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} while loading the PDF.`);
  return res.arrayBuffer();
}

function fileAccessHint() {
  return 'Could not read the local file. Enable "Allow access to file URLs" for pdf120 in chrome://extensions.';
}

export function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    return last || u.hostname || "document.pdf";
  } catch {
    return "document.pdf";
  }
}
