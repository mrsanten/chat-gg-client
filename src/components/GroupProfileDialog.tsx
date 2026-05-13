import { useEffect, useState } from "react";
import sunIcon from "../assets/sun.svg";
import * as serverApi from "../lib/serverApi";
import type {
  ServerContact,
  ServerGroup,
  ServerGroupMember,
} from "../lib/serverApi";

interface Props {
  open: boolean;
  group: ServerGroup | null;
  contacts: ServerContact[];
  serverUrl: string;
  token: string;
  myAccountId: string | null;
  onClose: () => void;
  /** Wywoływane po delete grupy / leave — rodzic czyści activeGroupId. */
  onLeftOrDeleted: () => void;
}

export function GroupProfileDialog(props: Props) {
  const { open, group, contacts, serverUrl, token, myAccountId, onClose, onLeftOrDeleted } = props;
  const [members, setMembers] = useState<ServerGroupMember[]>([]);
  const [editName, setEditName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isAdmin = group?.my_role === "admin";

  useEffect(() => {
    if (!open || !group) return;
    setEditName(group.name);
    setErr(null);
    void (async () => {
      try {
        const list = await serverApi.listGroupMembers(serverUrl, token, group.id);
        setMembers(list);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [open, group, serverUrl, token]);

  if (!open || !group) return null;

  const saveName = async () => {
    const name = editName.trim();
    if (!name || name === group.name) return;
    setSavingName(true);
    setErr(null);
    try {
      await serverApi.updateGroup(serverUrl, token, group.id, name);
      // Server emit-uje GroupsChanged → rodzic refreshuje listę.
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingName(false);
    }
  };

  const addMember = async () => {
    const u = addUsername.trim();
    if (!u) return;
    setBusy(true);
    setErr(null);
    try {
      await serverApi.addGroupMember(serverUrl, token, group.id, u);
      setAddUsername("");
      // Re-fetch members
      const list = await serverApi.listGroupMembers(serverUrl, token, group.id);
      setMembers(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (accountId: string) => {
    if (!confirm("Usunąć tego członka z grupy?")) return;
    setBusy(true);
    setErr(null);
    try {
      await serverApi.removeGroupMember(serverUrl, token, group.id, accountId);
      const list = await serverApi.listGroupMembers(serverUrl, token, group.id);
      setMembers(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!myAccountId) return;
    if (!confirm("Na pewno opuścić grupę?")) return;
    setBusy(true);
    try {
      await serverApi.removeGroupMember(serverUrl, token, group.id, myAccountId);
      onLeftOrDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const deleteGrp = async () => {
    if (!confirm(`Na pewno usunąć grupę „${group.name}"? Wiadomości i członkostwo zostaną skasowane.`)) return;
    setBusy(true);
    try {
      await serverApi.deleteGroup(serverUrl, token, group.id);
      onLeftOrDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // Sugestie auto-complete z kontaktów którzy NIE są jeszcze członkami.
  const memberIds = new Set(members.map((m) => m.account_id));
  const nonMemberContacts = contacts.filter((c) => !memberIds.has(c.peer_id));

  return (
    <div className="gg-modal-backdrop" onClick={onClose}>
      <div className="gg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gg-modal-titlebar">
          <img src={sunIcon} alt="" className="gg-chatwin-titlebar-icon" />
          <span className="gg-chatwin-titlebar-text">Profil grupy</span>
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
        <div className="gg-modal-body">
          <fieldset className="gg-fieldset">
            <legend>Nazwa</legend>
            <div className="gg-field" style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                className="gg-text-input"
                value={editName}
                disabled={!isAdmin || savingName}
                maxLength={80}
                onChange={(e) => setEditName(e.target.value)}
                style={{ flex: 1 }}
              />
              {isAdmin && editName.trim() && editName.trim() !== group.name && (
                <button
                  type="button"
                  className="gg-section-action"
                  onClick={() => void saveName()}
                  disabled={savingName}
                >
                  {savingName ? "Zapisuję…" : "Zapisz"}
                </button>
              )}
            </div>
          </fieldset>

          <fieldset className="gg-fieldset">
            <legend>Członkowie ({members.length})</legend>
            <div className="gg-creategroup-list">
              {members.map((m) => (
                <div key={m.account_id} className="gg-creategroup-row">
                  <span style={{ flex: 1 }}>
                    {m.username}
                    {m.role === "admin" && (
                      <span className="gg-creategroup-meta"> (admin)</span>
                    )}
                  </span>
                  {isAdmin && m.account_id !== myAccountId && (
                    <button
                      type="button"
                      className="gg-session-del"
                      onClick={() => void removeMember(m.account_id)}
                      title="Usuń z grupy"
                      disabled={busy}
                    >
                      <span className="gg-glyph gg-glyph--close" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </fieldset>

          {isAdmin && (
            <fieldset className="gg-fieldset">
              <legend>Dodaj członka</legend>
              <div className="gg-field" style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  list="gg-add-member-list"
                  className="gg-text-input"
                  placeholder="username"
                  value={addUsername}
                  onChange={(e) => setAddUsername(e.target.value)}
                  style={{ flex: 1 }}
                  disabled={busy}
                />
                <datalist id="gg-add-member-list">
                  {nonMemberContacts.map((c) => (
                    <option key={c.peer_id} value={c.username} />
                  ))}
                </datalist>
                <button
                  type="button"
                  className="gg-section-action"
                  onClick={() => void addMember()}
                  disabled={busy || !addUsername.trim()}
                >
                  + Dodaj
                </button>
              </div>
            </fieldset>
          )}

          {err && (
            <div className="gg-field" style={{ color: "var(--gg-orange)" }}>
              {err}
            </div>
          )}

          <div className="gg-modal-actions">
            <button
              type="button"
              className="gg-section-action"
              onClick={() => void leave()}
              disabled={busy}
            >
              Opuść grupę
            </button>
            {isAdmin && (
              <button
                type="button"
                className="gg-section-action"
                onClick={() => void deleteGrp()}
                disabled={busy}
                style={{ background: "var(--gg-orange)", color: "#fff" }}
              >
                Usuń grupę
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
