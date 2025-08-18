import React, { useEffect, useRef, useState } from "react";
import MediaCard from "@gl-admin/components/media/MediaCard";
import { api, getMediaURL } from "@gl-admin/lib/api";
import type { Media } from "@gl-admin/lib/types";
import GLAdminButton from "@gl-admin/components/ui/Button";
import Icon from "@gl-admin/components/ui/Icon";

import { initializeMediaCardHandlers } from "@gl-admin/scripts/media-card-handlers"
import "@gl-admin/assets/styles/pages/media.scss";

function formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

const Media: React.FC = () => {
    const [mediaItems, setMediaItems] = useState<Media[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [total, setTotal] = useState<number>(0);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<{ name: string; size: number; progress: number; status: string; error?: boolean }[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        api.getMedia()
            .then((response) => {
                setMediaItems(response.data);
                setTotal(response.meta.total);
            })
            .catch((e) => {
                setError(e instanceof Error ? e.message : "Failed to fetch media");
                console.error("Error fetching media:", e);
            });

        initializeMediaCardHandlers()
    }, []);

    // Upload logic
    const handleFileUpload = async (files: File[]) => {
        setUploading(true);
        setUploadProgress([]);
        const progressArr: typeof uploadProgress = [];

        for (const file of files) {
            progressArr.push({ name: file.name, size: file.size, progress: 0, status: "Uploading..." });
        }
        setUploadProgress([...progressArr]);

        const uploadPromises = files.map((file, idx) => uploadSingleFile(file, idx));
        const results = await Promise.allSettled(uploadPromises);

        const successCount = results.filter((r) => r.status === "fulfilled" && r.value).length;
        const failCount = results.length - successCount;

        setTimeout(() => {
            if (successCount > 0) {
                showToast(`Successfully uploaded ${successCount} file${successCount !== 1 ? "s" : ""}${failCount > 0 ? `, ${failCount} failed` : ""}`, "success");
                setTimeout(() => window.location.reload(), 1500);
            } else {
                showToast("All uploads failed", "error");
            }
            setUploading(false);
        }, 1000);
    };

    const uploadSingleFile = async (file: File, idx: number): Promise<boolean> => {
        try {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("name", file.name);
            formData.append("description", `Uploaded file: ${file.name}`);
            formData.append("alt", file.name.split(".")[0]);

            await api.createMedia(formData);

            let progress = 0;
            const interval = setInterval(() => {
                progress += Math.random() * 20;
                if (progress > 90) progress = 90;
                setUploadProgress((prev) => {
                    const copy = [...prev];
                    copy[idx] = { ...copy[idx], progress, status: `${Math.round(progress)}%` };
                    return copy;
                });
            }, 100);

            await new Promise((resolve) => setTimeout(resolve, 500));
            clearInterval(interval);

            setUploadProgress((prev) => {
                const copy = [...prev];
                copy[idx] = { ...copy[idx], progress: 100, status: "Complete" };
                return copy;
            });

            return true;
        } catch (error) {
            console.error("Upload error:", error);
            setUploadProgress((prev) => {
                const copy = [...prev];
                copy[idx] = { ...copy[idx], status: "Failed", error: true };
                return copy;
            });
            return false;
        }
    };

    // Toast logic
    const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
    const showToast = (message: string, type: "success" | "error" | "info" = "info") => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 4700);
    };

    // Upload area show/hide
    const [showUploadArea, setShowUploadArea] = useState(false);

    const handleNewMediaClick = () => setShowUploadArea(true);
    const handleCancelUploadClick = () => {
        setShowUploadArea(false);
        setUploading(false);
        setUploadProgress([]);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleUploadBtnClick = () => fileInputRef.current?.click();

    const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const files = Array.from(e.target.files);
            if (files.length > 0) handleFileUpload(files);
        }
    };

    // Drag & drop
    const uploadAreaRef = useRef<HTMLDivElement>(null);
    const [dragOver, setDragOver] = useState(false);

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setDragOver(true);
    };
    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setDragOver(false);
    };
    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) handleFileUpload(files);
    };

    return (
        <>
            <div className="gl-admin-media-library">
                <div className="gl-admin-media-header">
                    <div className="gl-admin-media-header-left">
                        <h1 className="gl-admin-media-header__title">Media Library</h1>
                        {/* <p className="gl-admin-media-header__count">{total} {total === 1 ? 'item' : 'items'}</p> */}
                    </div>
                    <div className="gl-admin-media-header-right">
                        <div className="gl-admin-media-header__filters">
                            <div className="gl-admin-media-header__filter-wrapper">
                                <select className="gl-admin-media-header__filter" id="media-filter-author">
                                    <option value="">All Authors</option>
                                    {/* TODO: Add author options dynamically */}
                                </select>
                            </div>
                            <div className="gl-admin-media-header__filter-wrapper">
                                <select className="gl-admin-media-header__filter" id="media-filter-type">
                                    <option value="">All Types</option>
                                    <option value="image">Images</option>
                                    <option value="video">Videos</option>
                                    <option value="audio">Audio</option>
                                    <option value="document">Documents</option>
                                </select>
                            </div>
                            <div className="gl-admin-media-header__sort-wrapper">
                                <label htmlFor="media-sort" className="gl-admin-media-header__sort-label">Sort by:</label>
                                <select className="gl-admin-media-header__sort" id="media-sort">
                                    <option value="date_desc">Last Added</option>
                                    <option value="date_asc">Oldest First</option>
                                    <option value="name_asc">Name A-Z</option>
                                    <option value="name_desc">Name Z-A</option>
                                    <option value="size_desc">Largest First</option>
                                    <option value="size_asc">Smallest First</option>
                                    <option value="type_asc">Type A-Z</option>
                                    <option value="type_desc">Type Z-A</option>
                                    <option value="posts_desc">Most Used</option>
                                    <option value="posts_asc">Least Used</option>
                                </select>
                            </div>
                        </div>
                        <div className="gl-admin-media-header__button-wrapper">
                            <GLAdminButton className="gl-admin-media__bulk-select" variation="flat">
                                <Icon name="bulkSelectIcon" color="#333536" width="14" height="14" /> Bulk Select
                            </GLAdminButton>
                            <GLAdminButton className="gl-admin-media__new-media-btn" onClick={handleNewMediaClick}>
                                <Icon name="add" color="white" width="14" height="14" /> New Media
                            </GLAdminButton>
                        </div>
                    </div>
                </div>

                {showUploadArea && (
                    <div
                        className={`gl-admin-media__upload-area${dragOver ? " gl-admin-media__upload-area--dragover" : ""}`}
                        ref={uploadAreaRef}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                    >
                        <div className="gl-admin-media__upload-area-header">
                            <h3>Drop files to upload</h3>
                            <div>
                                <span>or</span>
                                <div className="gl-admin-media__upload-area-button-wrapper">
                                    <GLAdminButton className="gl-admin-media__upload-btn" onClick={handleUploadBtnClick}>
                                        <Icon name="uploadIcon" color="white" width="14" height="14" /> Upload Files
                                    </GLAdminButton>
                                    <GLAdminButton
                                        className="gl-admin-media__cancel-upload-btn"
                                        variation="flat"
                                        onClick={handleCancelUploadClick}
                                    >
                                        Cancel
                                    </GLAdminButton>
                                </div>
                            </div>
                            <small>
                                Maximum size: 50MB. Supported: Images, Videos, Audio, Documents
                                {/* TODO:import number from env size limit */}
                            </small>
                        </div>
                        <input
                            type="file"
                            ref={fileInputRef}
                            multiple
                            accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt"
                            style={{ display: "none" }}
                            onChange={handleFileInputChange}
                        />
                    </div>
                )}

                {uploading && (
                    <div className="gl-admin-media__upload-progress">
                        {uploadProgress.map((item, idx) => (
                            <div className="gl-admin-media__progress-item" key={idx}>
                                <div className="gl-admin-media__progress-info">
                                    <span className="gl-admin-media__file-name">{item.name}</span>
                                    <span className="gl-admin-media__file-size">{formatFileSize(item.size)}</span>
                                </div>
                                <div className="gl-admin-media__progress-bar">
                                    <div
                                        className={`gl-admin-media__progress-fill${item.error ? " gl-admin-media__progress-fill--error" : item.progress === 100 ? " gl-admin-media__progress-fill--success" : ""}`}
                                        style={{ width: `${item.progress}%` }}
                                    ></div>
                                </div>
                                <span className={`gl-admin-media__progress-status${item.error ? " gl-admin-media__progress-status--error" : item.progress === 100 ? " gl-admin-media__progress-status--success" : ""}`}>
                                    {item.status}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                {error && (
                    <div className="error-message">
                        <strong>Error:</strong> {error}
                    </div>
                )}

                <div className="gl-admin-media__container">
                    <div className="gl-admin-media__grid">
                        {mediaItems.map((media) => (
                            <MediaCard key={media.id} media={media} />
                        ))}
                    </div>
                    {mediaItems.length === 0 && !error && (
                        <div className="empty-state">
                            <div className="empty-icon" />
                            <h3>No media files yet</h3>
                            <p>Upload your first file by clicking "New Media" above</p>
                        </div>
                    )}
                </div>

                {toast && (
                    <div className={`toast toast--${toast.type}`}>
                        {toast.message}
                    </div>
                )}

            </div>
        </>
    );
};

export default Media;
