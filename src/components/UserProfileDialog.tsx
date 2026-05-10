import { useEffect, useState } from "react";
import sunIcon from "../assets/sun.svg";

export interface UserProfileData {
  username: string;
  /** Nick z relacji kontakt (tylko peer). Nieobecny dla własnego profilu. */
  nickname?: string | null;
  description?: string;
  avatar?: string;
  /** ISO date z servera (created_at). */
  joinedAt?: string;
  presence?: "online" | "afk" | "offline" | "connecting" | "logged_out" | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** "self" → editable; "peer" → read-only. */
  mode: "self" | "peer";
  data: UserProfileData;
  /** Tylko self: kliknięcie „Zmień avatar" wywołuje to (rodzic odpala file picker). */
  onChangeAvatar?: () => void;
  /** Tylko self: rodzic dostaje nowy opis i sam debounce-uje save. */
  onDescriptionChange?: (description: string) => void;
}

export function UserProfileDialog({
  open,
  onClose,
  mode,
  data,
  onChangeAvatar,
  onDescriptionChange,
}: Props) {
  const [draftDesc, setDraftDesc] = useState(data.description ?? "");

  // Resetuj draft przy otwarciu / zmianie usera, żeby pokazywał świeży opis.
  useEffect(() => {
    if (open) setDraftDesc(data.description ?? "");
  }, [open, data.description, data.username]);

  // ESC zamyka.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const isSelf = mode === "self";
  const presenceLabel =
    data.presence === "online"
      ? "Dostępny"
      : data.presence === "afk"
        ? "Zaraz wracam"
        : data.presence === "connecting"
          ? "Łączenie…"
          : data.presence === "offline"
            ? "Offline"
            : data.presence === "logged_out"
              ? "Niezalogowany"
              : null;

  return (
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div className="gg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gg-modal-titlebar">
          <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
          <span className="gg-chatwin-titlebar-text">
            {isSelf ? "Mój profil" : "Profil użytkownika"}
          </span>
          <div className="gg-chatwin-titlebar-buttons">
            <button
              className="gg-chatwin-titlebar-btn"
              onClick={onClose}
              aria-label="Zamknij"
            >
              <span className="gg-glyph gg-glyph--close" />
            </button>
          </div>
        </div>
        <div className="gg-modal-body gg-userprofile">
          <div className="gg-userprofile-head">
            <div className="gg-userprofile-avatar">
              {data.avatar && data.avatar.length > 0 ? (
                <img src={data.avatar} alt="" />
              ) : (
                <img src={sunIcon} alt="" className="gg-userprofile-avatar-fallback" />
              )}
            </div>
            <div className="gg-userprofile-meta">
              <div className="gg-userprofile-name">{data.username}</div>
              {data.nickname && data.nickname.trim().length > 0 && (
                <div className="gg-userprofile-nick">
                  Twój nick: <strong>{data.nickname}</strong>
                </div>
              )}
              {presenceLabel && (
                <div
                  className={`gg-profile-status gg-profile-status--${data.presence ?? "logged_out"}`}
                >
                  {presenceLabel}
                </div>
              )}
              <div className="gg-userprofile-joined">
                Dołączył(a):&nbsp;
                <span>{formatJoined(data.joinedAt)}</span>
              </div>
            </div>
          </div>

          {isSelf && onChangeAvatar && (
            <div className="gg-userprofile-row">
              <button
                type="button"
                className="gg-section-action"
                onClick={onChangeAvatar}
              >
                Zmień avatar
              </button>
            </div>
          )}

          <div className="gg-userprofile-row">
            <label className="gg-userprofile-label">Opis</label>
            {isSelf && onDescriptionChange ? (
              <textarea
                className="gg-text-input gg-userprofile-desc-input"
                rows={3}
                maxLength={200}
                placeholder="Wpisz coś o sobie…"
                value={draftDesc}
                onChange={(e) => {
                  setDraftDesc(e.target.value);
                  onDescriptionChange(e.target.value);
                }}
              />
            ) : (
              <div className="gg-userprofile-desc">
                {data.description && data.description.trim().length > 0
                  ? data.description
                  : <span className="gg-userprofile-desc-empty">Brak opisu.</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatJoined(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("pl-PL", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
