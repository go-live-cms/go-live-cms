import { useCallback, useEffect, useRef, useState } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import {
  deletePluginData,
  disablePlugin,
  enablePlugin,
  getPluginSettings,
  listPlugins,
  updatePluginSettings,
  type Plugin,
  type PluginSettingField,
  type PluginSettings,
} from "@gl-admin/lib/api/plugins"
import {
  declaredUses,
  disableSummary,
  draftProblems,
  fieldLabel,
  initialDraft,
  optionLabel,
  pluginActions,
  pluginConflictMessage,
  settingsChanges,
  statusLabel,
  statusNote,
  type FieldDraft,
  type SecretDraft,
  type SettingsDraft,
} from "@gl-admin/lib/pluginsPage"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { toast } from "@gl-admin/components/ui/Toast"
import Button from "@gl-admin/components/ui/Button"
import Pill from "@gl-admin/components/ui/Pill"
import Modal from "@gl-admin/components/ui/Modal"
import Drawer from "@gl-admin/components/ui/Drawer"
import Notice from "@gl-admin/components/ui/Notice"
import Input from "@gl-admin/components/ui/Input"
import Select from "@gl-admin/components/ui/Select"
import Switch from "@gl-admin/components/ui/Switch"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import NavIcon from "@gl-admin/components/sidebar/NavIcon"
import { ErrorPage } from "@gl-admin/components/errors/ErrorPages"
import "@gl-admin/assets/styles/pages/workspace.scss"
import "@gl-admin/assets/styles/pages/plugins.scss"

// Plugins (#11, the redesign canvas's "Plugins" board), admins only: every registered
// plugin with its status and what it declares, Enable and Disable behind their
// confirmations, and the settings panel built from the manifest (#457).
//
// Hidden until their issues land: upload and delete (installing is shipping in the
// image), "Update to x.y" (#332), and the disable dialog's "Used in N posts" (#456's
// GET /plugins/:slug/usage).

const PluginsPage = () => {
  const { baseTitle } = useGoLive()
  const [plugins, setPlugins] = useState<Plugin[] | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [enabling, setEnabling] = useState<Plugin | null>(null)
  const [disabling, setDisabling] = useState<Plugin | null>(null)
  const [busy, setBusy] = useState(false)
  const [configuring, setConfiguring] = useState<Plugin | null>(null)

  const load = useCallback(async (refresh = false) => {
    try {
      setLoadError(null)
      const rsp = await listPlugins()
      setPlugins(rsp.plugins)
    } catch (error) {
      // A reload after a change keeps the list on screen.
      if (refresh) toast.error(`Couldn't reload the plugins. ${errorMessage(error)}`)
      else setLoadError(error)
    }
  }, [])

  useEffect(() => {
    document.title = `${baseTitle} Plugins`
    load()
  }, [baseTitle, load])

  const replace = (updated: Plugin) => setPlugins((list) => list?.map((p) => (p.slug === updated.slug ? updated : p)) ?? null)

  const toggle = async (plugin: Plugin, enable: boolean) => {
    setBusy(true)
    try {
      const updated = enable ? await enablePlugin(plugin.slug) : await disablePlugin(plugin.slug)
      replace(updated)
      toast.success(enable ? `${plugin.name} is enabled` : `${plugin.name} is disabled`)
      setEnabling(null)
      setDisabling(null)
    } catch (error) {
      const conflict = error instanceof ApiError ? pluginConflictMessage(error.code) : null
      toast.error(`Couldn't ${enable ? "enable" : "disable"} ${plugin.name}. ${conflict ?? errorMessage(error)}`)
      if (conflict) {
        setEnabling(null)
        setDisabling(null)
        load(true)
      }
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <header className="gl-workspace__header">
      <div className="gl-workspace__heading">
        <h1>Plugins</h1>
        <span className="gl-workspace__subtitle">Add blocks and server features to your site. Adding or removing a plugin takes a new deploy.</span>
      </div>
    </header>
  )

  if (loadError) return <ErrorPage error={loadError} onRetry={() => load()} />

  if (!plugins) {
    return (
      <div className="gl-workspace gl-plugins" aria-busy="true">
        {header}
        <div className="gl-plugins__list" aria-hidden="true">
          {["34%", "26%", "42%"].map((width) => (
            <div key={width} className="gl-plugin gl-plugin--skeleton">
              <div className="gl-plugin__body">
                <Skeleton width={width} height={14} />
                <Skeleton width="72%" height={10} />
              </div>
              <Skeleton width={72} height={32} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="gl-workspace gl-plugins">
      {header}

      {plugins.length === 0 ? (
        <EmptyState
          icon={<NavIcon name="plugins" size={24} />}
          title="No plugins installed"
          description="Plugins ship with your GoLive build. Once one is added and deployed, it appears here, turned off until you enable it."
        />
      ) : (
        <ul className="gl-plugins__list" aria-label="Installed plugins">
          {plugins.map((plugin) => (
            <PluginRow
              key={plugin.slug}
              plugin={plugin}
              onEnable={() => setEnabling(plugin)}
              onDisable={() => setDisabling(plugin)}
              onSettings={() => setConfiguring(plugin)}
            />
          ))}
        </ul>
      )}

      {enabling && <EnableDialog plugin={enabling} busy={busy} onCancel={() => setEnabling(null)} onConfirm={() => toggle(enabling, true)} />}
      {disabling && <DisableDialog plugin={disabling} busy={busy} onCancel={() => setDisabling(null)} onConfirm={() => toggle(disabling, false)} />}
      {configuring && <SettingsPanel plugin={configuring} onClose={() => setConfiguring(null)} />}
    </div>
  )
}

function PluginRow({ plugin, onEnable, onDisable, onSettings }: { plugin: Plugin; onEnable: () => void; onDisable: () => void; onSettings: () => void }) {
  const actions = pluginActions(plugin)
  const status = statusLabel(plugin)
  const note = statusNote(plugin)
  const uses = declaredUses(plugin)
  const nameId = `gl-plugin-${plugin.slug}`
  return (
    <li className="gl-plugin" aria-labelledby={nameId}>
      <div className="gl-plugin__body">
        <div className="gl-plugin__title">
          <h2 id={nameId}>{plugin.name}</h2>
          <span className="gl-plugin__version">{plugin.version}</span>
          {plugin.active && <Pill tone="success">Enabled</Pill>}
          {status && <Pill tone="warning">{status}</Pill>}
        </div>
        {plugin.description && <p className="gl-plugin__description">{plugin.description}</p>}
        {note && <p className="gl-plugin__description">{note}</p>}
        <div className="gl-plugin__meta">
          {plugin.author && <span>By {plugin.author}</span>}
          {uses.length > 0 && (
            <ul className="gl-plugin__caps" aria-label="What it says it uses">
              {uses.map((use) => (
                <li key={use.name} className="gl-plugin__cap" title={use.description}>
                  {use.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="gl-plugin__actions">
        {actions.settings && (
          <Button variant="secondary" onClick={onSettings} aria-label={`Settings for ${plugin.name}`}>
            Settings
          </Button>
        )}
        {actions.disable && (
          <Button variant="secondary" onClick={onDisable} aria-label={`Disable ${plugin.name}`}>
            Disable
          </Button>
        )}
        {actions.enable && (
          <Button variant="secondary" onClick={onEnable} aria-label={`Enable ${plugin.name}`}>
            Enable
          </Button>
        )}
        {actions.enableUnavailable && (
          <Button variant="secondary" disabled aria-label={`Enable ${plugin.name} (not available)`}>
            Enable
          </Button>
        )}
      </div>
    </li>
  )
}

type ConfirmProps = { plugin: Plugin; busy: boolean; onCancel: () => void; onConfirm: () => void }

function EnableDialog({ plugin, busy, onCancel, onConfirm }: ConfirmProps) {
  const uses = declaredUses(plugin)
  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={`Enable ${plugin.name}?`}
      size="small"
      footer={
        <div className="gl-plugins__footer">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={busy}>
            Enable plugin
          </Button>
        </div>
      }
    >
      <div className="gl-plugins__dialog">
        <Notice tone="warning" title="This plugin runs on your server with full access to your site’s data.">
          Only enable plugins you trust.
        </Notice>
        {uses.length > 0 && (
          <div className="gl-plugins__declared">
            <h3>What it says it uses</h3>
            <ul>
              {uses.map((use) => (
                <li key={use.name}>
                  <span className="gl-plugins__declared-name">{use.name}</span>
                  {use.description && <span className="gl-plugins__declared-desc">{use.description}</span>}
                </li>
              ))}
            </ul>
            <p className="gl-workspace__muted">The plugin declares these itself. GoLive shows them so you know what to expect, but doesn’t limit the plugin to them.</p>
          </div>
        )}
      </div>
    </Modal>
  )
}

function DisableDialog({ plugin, busy, onCancel, onConfirm }: ConfirmProps) {
  const summary = disableSummary(plugin)
  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={`Disable ${plugin.name}?`}
      size="small"
      role="alertdialog"
      footer={
        <div className="gl-plugins__footer">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={busy}>
            Disable plugin
          </Button>
        </div>
      }
    >
      <div className="gl-plugins__dialog">
        {summary.body && (
          <p>
            {summary.lead && <strong>{summary.lead} </strong>}
            {summary.body}
          </p>
        )}
        <p className="gl-workspace__muted">{summary.after}</p>
      </div>
    </Modal>
  )
}

function SettingsPanel({ plugin, onClose }: { plugin: Plugin; onClose: () => void }) {
  const [settings, setSettings] = useState<PluginSettings | null>(null)
  const [draft, setDraft] = useState<SettingsDraft>({})
  const [loadError, setLoadError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const apply = (next: PluginSettings) => {
    setSettings(next)
    setDraft(initialDraft(next))
    setShowErrors(false)
  }

  const load = useCallback(async () => {
    try {
      setLoadError(null)
      apply(await getPluginSettings(plugin.slug))
    } catch (error) {
      setLoadError(error)
    }
  }, [plugin.slug])

  useEffect(() => {
    load()
  }, [load])

  const problems = settings ? draftProblems(settings, draft) : {}
  const changes = settings ? settingsChanges(settings, draft) : {}
  const dirty = Object.keys(changes).length > 0

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!settings) return
    if (Object.keys(problems).length > 0) {
      setShowErrors(true)
      return
    }
    if (!dirty) return
    setSaving(true)
    try {
      await updatePluginSettings(plugin.slug, changes)
      toast.success(`${plugin.name} settings saved`)
      onClose()
    } catch (error) {
      const conflict = error instanceof ApiError ? pluginConflictMessage(error.code) : null
      toast.error(`Couldn't save the settings. ${conflict ?? errorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const deleteData = async () => {
    setDeleting(true)
    try {
      await deletePluginData(plugin.slug)
    } catch (error) {
      toast.error(`Couldn't delete the data. ${errorMessage(error)}`)
      setDeleting(false)
      return
    }
    toast.success(`${plugin.name}’s data was deleted`)
    setConfirmDelete(false)
    setDeleting(false)
    // The defaults apply again; a failed reload shows the panel's own error state, never
    // "couldn't delete", since the data is gone.
    setSettings(null)
    load()
  }

  const set = (name: string, value: FieldDraft) => setDraft((d) => ({ ...d, [name]: value }))

  return (
    <>
      <Drawer
        isOpen
        onClose={onClose}
        title={`${plugin.name} settings`}
        width={440}
        className="gl-plugin-settings"
        closeOnBackdrop={false}
        footer={
          <div className="gl-plugins__footer">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="gl-plugin-settings-form" loading={saving} disabled={!settings || !dirty}>
              Save settings
            </Button>
          </div>
        }
      >
        {loadError ? (
          <EmptyState
            compact
            variant="error"
            icon="close"
            title="Couldn't load the settings"
            description={errorMessage(loadError)}
            action={
              <Button variant="primary" onClick={load}>
                Try again
              </Button>
            }
          />
        ) : !settings ? (
          <div aria-busy="true" className="gl-plugin-settings__form">
            <Skeleton height={56} />
            <Skeleton height={56} />
          </div>
        ) : (
          <form id="gl-plugin-settings-form" className="gl-plugin-settings__form" onSubmit={save} noValidate>
            {settings.fields.map((field) => (
              <SettingField
                key={field.name}
                field={field}
                value={draft[field.name]}
                error={showErrors ? problems[field.name] : undefined}
                onChange={(value) => set(field.name, value)}
              />
            ))}
            <div className="gl-plugin-settings__danger">
              <Button variant="ghost" className="gl-plugin-settings__delete" onClick={() => setConfirmDelete(true)}>
                Delete plugin data
              </Button>
              <span className="gl-workspace__muted">Removes this plugin’s saved settings. Its blocks in your posts aren’t touched.</span>
            </div>
          </form>
        )}
      </Drawer>

      <Modal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${plugin.name}’s data?`}
        size="small"
        role="alertdialog"
        footer={
          <div className="gl-plugins__footer">
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={deleteData} loading={deleting}>
              Delete data
            </Button>
          </div>
        }
      >
        <p className="gl-plugins__dialog">
          Its saved settings, secrets included, are removed and the defaults apply again. Its blocks in your posts aren’t touched. This can’t be undone.
        </p>
      </Modal>
    </>
  )
}

function SettingField({ field, value, error, onChange }: { field: PluginSettingField; value: FieldDraft | undefined; error?: string; onChange: (value: FieldDraft) => void }) {
  const id = `gl-plugin-setting-${field.name}`
  const label = fieldLabel(field)
  const hint = field.description

  if (field.secret) return <SecretField id={id} field={field} value={value as SecretDraft} error={error} onChange={onChange} />

  if (field.type === "boolean") {
    return <Switch id={id} label={label} description={hint} checked={value === true} onChange={onChange} />
  }

  if (field.enum) {
    return (
      <Select
        id={id}
        label={label}
        hint={hint}
        error={error}
        value={typeof value === "string" ? value : ""}
        onChange={onChange}
        placeholder="Choose…"
        options={field.enum.map((option) => ({ value: String(option), label: optionLabel(option) }))}
      />
    )
  }

  const number = field.type === "number"
  return (
    <Input
      id={id}
      title={label}
      hint={hint}
      error={error}
      unmasked
      inputMode={number ? (field.integer ? "numeric" : "decimal") : undefined}
      containerClassName={number ? "gl-plugin-settings__number" : undefined}
      value={typeof value === "string" ? value : ""}
      placeholder={field.default != null ? String(field.default) : undefined}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  )
}

// A secret is write-only: once saved it shows "Saved" and Replace, never the value.
function SecretField({ id, field, value, error, onChange }: { id: string; field: PluginSettingField; value: SecretDraft; error?: string; onChange: (value: FieldDraft) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const label = fieldLabel(field)
  const draft = value ?? { set: false, replacing: false, value: "" }

  useEffect(() => {
    if (draft.replacing) inputRef.current?.focus()
  }, [draft.replacing])

  if (draft.set && !draft.replacing) {
    return (
      <div className="gl-plugin-settings__secret">
        <span id={`${id}-label`} className="gl-plugin-settings__label">
          {label}
        </span>
        <div role="group" aria-labelledby={`${id}-label`} className="gl-plugin-settings__saved">
          <span>Saved</span>
          <Button variant="ghost" size="sm" onClick={() => onChange({ ...draft, replacing: true, value: "" })} aria-label={`Replace ${label}`}>
            Replace
          </Button>
        </div>
        <span className="gl-workspace__muted gl-plugin-settings__hint">Once saved, a key can be replaced but never shown again.</span>
      </div>
    )
  }

  return (
    <div className="gl-plugin-settings__secret">
      <Input
        ref={inputRef}
        id={id}
        title={label}
        type="password"
        unmasked
        autoComplete="off"
        hint={[field.description, draft.set ? "Leave it empty to keep the saved one." : "Once saved, it can be replaced but never shown again."].filter(Boolean).join(" ")}
        error={error}
        value={draft.value}
        onChange={(e) => onChange({ ...draft, value: e.currentTarget.value })}
      />
      {draft.set && (
        <Button variant="ghost" size="sm" onClick={() => onChange({ ...draft, replacing: false, value: "" })}>
          Keep the saved one
        </Button>
      )}
    </div>
  )
}

export default PluginsPage
