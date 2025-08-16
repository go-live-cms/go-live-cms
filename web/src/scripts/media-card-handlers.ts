import { api, getMediaURL } from "@/lib/api";
import type { Media } from "@/lib/types";

export function initializeMediaCardHandlers() {
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    if (target.matches(".gl-admin-media-card__action--edit")) {
      const mediaId = target.dataset.id;
      if (mediaId) {
        console.log("Edit media:", mediaId);
      }
    }

    if (target.matches(".gl-admin-media-card__action--delete")) {
      const mediaId = target.dataset.id;
      if (
        mediaId &&
        confirm("Are you sure you want to delete this media file?")
      ) {
        deleteMedia(parseInt(mediaId));
      }
    }

    if (target.matches(".gl-admin-media-card__action--copy")) {
      const mediaPath = target.dataset.path;
      if (mediaPath) {
        copyToClipboard(mediaPath);
      }
    }
  });
}

async function deleteMedia(id: number) {
  try {
    await api.deleteMedia(id);
    window.location.reload();
  } catch (error) {
    console.error("Delete error:", error);
    alert("Failed to delete media");
  }
}

async function copyToClipboard(mediaPath: string) {
  try {
    const fullUrl = getMediaURL(mediaPath);
    const absoluteUrl = fullUrl.startsWith("http")
      ? fullUrl
      : `${window.location.origin}${fullUrl}`;
    await navigator.clipboard.writeText(absoluteUrl);
    console.log("URL copied to clipboard");
  } catch (error) {
    console.error("Failed to copy URL:", error);
  }
}
