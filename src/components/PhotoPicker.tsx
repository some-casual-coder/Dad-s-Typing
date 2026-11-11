"use client";
import { useEffect, useMemo, useRef } from "react";

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 4 * 1024 * 1024;

// Client pre-check for fast feedback; the server re-checks the real bytes
export function photoProblem(f: File): string {
  if (/hei[cf]$/i.test(f.type) || /\.hei[cf]$/i.test(f.name)) {
    return "HEIC photos are not supported yet. Take a screenshot of the photo or choose a JPEG or PNG.";
  }
  if (!TYPES.includes(f.type)) return "Please choose a JPEG, PNG or WebP photo.";
  if (f.size > MAX_BYTES) return "That photo is too large. Please use one under 4 MB.";
  return "";
}

interface Props {
  file: File | null;
  alt: string;
  disabled?: boolean;
  label?: string;
  onFile: (f: File | null) => void;
  onAlt: (s: string) => void;
  onError: (msg: string) => void;
}

export default function PhotoPicker({ file, alt, disabled, label = "Add photo", onFile, onAlt, onError }: Props) {
  const gallery = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // lets the same file be chosen again
    onError("");
    if (!f) return; // chooser cancelled: nothing changes
    const problem = photoProblem(f);
    if (problem) onError(problem); else onFile(f);
  }

  return (
    <div className="stack">
      {preview && file && (
        <div className="preview">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={alt || `Photo you are about to send: ${file.name}`} />
          <label className="field"><span>Describe the photo (optional)</span>
            <input name="alt" value={alt} onChange={(e) => onAlt(e.target.value)} placeholder="e.g. grey carrier with a front door" /></label>
        </div>
      )}
      <div className="row">
        <input ref={gallery} type="file" accept="image/*" hidden tabIndex={-1} aria-hidden="true" data-testid="photo-input" onChange={pick} />
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} aria-hidden="true" data-testid="camera-input" onChange={pick} />
        <button type="button" className="btn secondary" disabled={disabled} onClick={() => gallery.current?.click()}>
          {file ? "Replace photo" : label}
        </button>
        <button type="button" className="btn secondary" disabled={disabled} onClick={() => camera.current?.click()}>Take photo</button>
        {file && (
          <button type="button" className="btn secondary" disabled={disabled} onClick={() => { onFile(null); onAlt(""); onError(""); }}>
            Remove photo
          </button>
        )}
      </div>
    </div>
  );
}
