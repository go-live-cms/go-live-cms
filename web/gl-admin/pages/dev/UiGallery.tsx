import { useState, type ReactNode } from "react"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import Input from "@gl-admin/components/ui/Input"
import Textarea from "@gl-admin/components/ui/Textarea"
import Select from "@gl-admin/components/ui/Select"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import Combobox from "@gl-admin/components/ui/Combobox"
import Checkbox from "@gl-admin/components/ui/Checkbox"
import RadioGroup from "@gl-admin/components/ui/RadioGroup"
import Switch from "@gl-admin/components/ui/Switch"
import Tabs from "@gl-admin/components/ui/Tabs"
import Pill from "@gl-admin/components/ui/Pill"
import Avatar, { AvatarStack } from "@gl-admin/components/ui/Avatar"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import Popover from "@gl-admin/components/ui/Popover"
import Modal from "@gl-admin/components/ui/Modal"
import Drawer from "@gl-admin/components/ui/Drawer"
import { toast } from "@gl-admin/components/ui/Toast"
import Tooltip from "@gl-admin/components/ui/Tooltip"
import Table from "@gl-admin/components/ui/Table"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Notice from "@gl-admin/components/ui/Notice"
import UnsavedChangesBar from "@gl-admin/components/ui/UnsavedChangesBar"
import PostStatus from "@gl-admin/components/ui/PostStatus"
import { DocumentIcon, MoreIcon, PlusIcon, SearchIcon } from "@gl-admin/components/ui/icons"
import { SidebarNav } from "@gl-admin/components/sidebar/Sidebar"
import { buildNavigation } from "@gl-admin/components/sidebar/nav"
import { ForbiddenPage, NotFoundPage, ServerErrorPage } from "@gl-admin/components/errors/ErrorPages"
import type { TaxonomyType } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/pages/ui-gallery.scss"

// Dev-only (#338): every shared component, side by side in the light and dark themes.
// Reached at /gl-admin/dev/ui under `astro dev`; not routed in production builds.

const PEOPLE = [
  { id: 4, name: "Luan" },
  { id: 2, name: "Ana Costa" },
  { id: 7, name: "Marco Ruiz" },
  { id: 3, name: "Priya N." },
  { id: 6, name: "Kenji T." },
]

const ROLES = [
  { value: "admin", label: "Admin", description: "Everything, including users and settings" },
  { value: "editor", label: "Editor", description: "Publishes and edits anyone's posts" },
  { value: "contributor", label: "Contributor", description: "Writes drafts; an editor publishes them" },
]

const CATEGORIES = ["Announcements", "Changelog", "Engineering", "Guides", "Product updates"].map((c) => ({
  value: c.toLowerCase(),
  label: c,
}))

type Row = { id: number; title: string; status: string; authors: number[]; edited: string }
const ROWS: Row[] = [
  { id: 1, title: "Shipping real-time collaboration", status: "draft", authors: [4, 2], edited: "Just now" },
  { id: 2, title: "Migrating from WordPress in an afternoon", status: "scheduled", authors: [7], edited: "2 hours ago" },
  { id: 3, title: "Analytics for every post", status: "published", authors: [3], edited: "Yesterday" },
  { id: 4, title: "Beta sign-up is open", status: "archived", authors: [4], edited: "Aug 12" },
]

const TAXONOMIES = [
  { name: "category", label: "Categories" },
  { name: "tag", label: "Tags" },
] as TaxonomyType[]

// The shell (#339) as each role sees it, on the Posts › Categories page.
const SHELLS = (["admin", "contributor"] as const).map((role) => ({
  role,
  sections: buildNavigation({ role, taxonomyTypes: TAXONOMIES }),
  current: role === "admin" ? "taxonomy-category" : "type-post",
}))

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gl-gallery__section">
      <h3 className="gl-gallery__heading">{title}</h3>
      <div className="gl-gallery__row">{children}</div>
    </section>
  )
}

function Panel({ theme }: { theme: "light" | "dark" }) {
  const [tab, setTab] = useState("all")
  const [role, setRole] = useState("editor")
  const [category, setCategory] = useState<string | null>(null)
  const [sort, setSort] = useState("edited")
  const [checked, setChecked] = useState(true)
  const [markdown, setMarkdown] = useState(true)
  const [selected, setSelected] = useState<(string | number)[]>([2])
  const [dialog, setDialog] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [tagline, setTagline] = useState("Notes from the GoLive team")
  const [saved, setSaved] = useState("Notes from the GoLive team")
  const [excerpt, setExcerpt] = useState("Two people can now edit the same post at once.")

  return (
    <div data-theme={theme} className="gl-gallery__panel">
      <h2 className="gl-gallery__title">{theme === "light" ? "Light" : "Dark"}</h2>

      <Section title="Buttons">
        <Button variant="primary" icon={<PlusIcon />}>
          New post
        </Button>
        <Button variant="secondary">Preview</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="danger">Delete</Button>
        <Button variant="primary" loading>
          Saving
        </Button>
        <Button variant="secondary" disabled>
          Previous
        </Button>
        <IconButton aria-label="More actions" icon={<MoreIcon />} />
        <Button variant="secondary" size="sm">
          Small
        </Button>
        <Button variant="primary" size="lg">
          Large
        </Button>
      </Section>

      <Section title="Fields">
        <div className="gl-gallery__stack">
          <Input title="Site title" name={`title-${theme}`} id={`title-${theme}`} defaultValue="GoLive Blog" hint="Shown in the browser tab and search results." />
          <Input title="Email" name={`email-${theme}`} id={`email-${theme}`} type="email" defaultValue="maya@golive" error="“maya@golive” isn't a complete email address." />
          <Textarea label="Excerpt" optional maxCount={160} value={excerpt} onChange={(e) => setExcerpt(e.target.value)} hint="Shown in lists and social previews." />
          <Select label="Role" options={ROLES} value={role} onChange={setRole} />
          <Combobox label="Category" options={CATEGORIES} value={category} onChange={setCategory} placeholder="Search categories" />
          <div className="gl-gallery__row">
            <FilterSelect
              prefix="Sort:"
              value={sort}
              onChange={setSort}
              options={[
                { value: "edited", label: "Last edited" },
                { value: "created", label: "Created" },
                { value: "title", label: "Title" },
              ]}
            />
            <FilterSelect options={[]} value="" onChange={() => {}} loading />
          </div>
        </div>
      </Section>

      <Section title="Choices">
        <div className="gl-gallery__stack">
          <Checkbox label="Allow comments" description="Readers can reply under the post." checked={checked} onChange={setChecked} />
          <Checkbox label="Some selected" indeterminate onChange={() => {}} />
          <Switch label="Markdown shortcuts" description="Typing # or - at the start of a line makes a heading or list." checked={markdown} onChange={setMarkdown} />
          <RadioGroup legend="Role" variant="card" options={ROLES} value={role} onChange={setRole} />
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs
          label="Views"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "all", label: "All", count: 48 },
            { id: "published", label: "Published", count: 31 },
            { id: "drafts", label: "Drafts", count: 12 },
            { id: "trash", label: "Trash", count: null },
          ]}
        />
      </Section>

      <Section title="Pills and avatars">
        <Pill tone="warning">Draft</Pill>
        <Pill tone="info">Scheduled</Pill>
        <Pill tone="success">Published</Pill>
        <Pill tone="accent">Changes not published</Pill>
        <Pill tone="neutral">Unpublished</Pill>
        <Pill tone="outline">Archived</Pill>
        <Pill tone="danger">Error</Pill>
        <Avatar user={PEOPLE[0]} size={32} />
        <AvatarStack users={PEOPLE} max={3} size={28} />
      </Section>

      <Section title="Menu, popover, tooltip">
        <Menu label="Post actions" trigger={(props) => <IconButton {...props} variant="secondary" aria-label="Actions for Analytics for every post" icon={<MoreIcon />} />}>
          <MenuItem onSelect={() => toast.info("Open")}>Open</MenuItem>
          <MenuItem onSelect={() => toast.info("View on site")}>View on site</MenuItem>
          <MenuItem onSelect={() => toast.info("Duplicated")}>Duplicate</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => toast.info("Unpublished")} description="Take it off the site, keep it as a draft">
            Unpublish
          </MenuItem>
          <MenuItem disabled onSelect={() => {}} description="Only admins can archive">
            Archive
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={() => toast.success("Moved to trash")}>
            Move to trash
          </MenuItem>
        </Menu>
        <Popover title="Filter by author" trigger={(props) => <Button {...props} variant="secondary" icon={<SearchIcon />}>Author</Button>}>
          {(close) => (
            <div className="gl-gallery__stack">
              {PEOPLE.slice(0, 3).map((p) => (
                <Checkbox key={p.id} label={p.name} onChange={() => {}} />
              ))}
              <Button variant="primary" size="sm" onClick={close}>
                Done
              </Button>
            </div>
          )}
        </Popover>
        <Tooltip content="Ana Costa" detail="Editing · Click to jump to cursor" placement="top">
          <button type="button" className="gl-gallery__plain">
            <Avatar user={PEOPLE[1]} decorative /> Hover or focus me
          </button>
        </Tooltip>
      </Section>

      <Section title="Dialog, drawer, toast">
        <Button variant="secondary" onClick={() => setDialog(true)}>
          Invite people
        </Button>
        <Button variant="secondary" onClick={() => setConfirm(true)}>
          Delete post
        </Button>
        <Button variant="secondary" onClick={() => setDrawer(true)}>
          Version history
        </Button>
        <Button variant="secondary" onClick={() => toast.success("Post published", { action: { label: "View post", onClick: () => {} } })}>
          Success toast
        </Button>
        <Button variant="secondary" onClick={() => toast.error("Couldn't publish: the URL is already used by another post.")}>
          Error toast
        </Button>
      </Section>

      <Section title="Notices">
        <div className="gl-gallery__stack">
          <Notice tone="info" title="View-only" inline actions={<Button size="sm" variant="secondary">Request access</Button>}>
            Contributors can't edit post content.
          </Notice>
          <Notice tone="warning" title="2 blocks couldn't be kept" onDismiss={() => {}} actions={<Button size="sm" variant="secondary">Undo paste</Button>}>
            GoLive doesn't support them yet, so they were left out of what you pasted.
          </Notice>
          <Notice tone="danger">Couldn't publish: the URL /blog/real-time-collaboration is already used by another post.</Notice>
        </div>
      </Section>

      <Section title="Table">
        <div className="gl-gallery__wide">
          <Table<Row>
            aria-label="Posts"
            selectable
            selectedKeys={selected}
            onSelectionChange={setSelected}
            rowLabel={(r) => r.title}
            maxHeight={240}
            data={ROWS}
            columns={[
              { key: "title", name: "Title", render: (v) => <span className="gl-table__heading-title">{String(v)}</span> },
              { key: "status", name: "Status", width: 150, render: (v) => <PostStatus status={String(v)} iconPath="-" /> },
              {
                key: "authors",
                name: "Authors",
                width: 96,
                render: (v) => v && <AvatarStack users={(v as unknown as number[]).map((id) => PEOPLE.find((p) => p.id === id)!)} />,
              },
              { key: "edited", name: "Last edited", width: 130 },
            ]}
          />
          <Table<Row> aria-label="Posts, loading" loading data={[]} columns={[{ key: "title", name: "Title" }, { key: "edited", name: "Last edited", width: 130 }]} />
        </div>
      </Section>

      <Section title="Empty and loading">
        <div className="gl-gallery__wide">
          <EmptyState
            compact
            icon={<DocumentIcon size={24} />}
            title="No posts yet"
            description="Write your first post, or bring existing ones over from WordPress or a Markdown export."
            action={
              <>
                <Button variant="primary" size="lg">
                  Write a post
                </Button>
                <Button variant="secondary" size="lg">
                  Import posts
                </Button>
              </>
            }
          />
          <div className="gl-gallery__row">
            <Skeleton shape="circle" width={24} height={24} />
            <Skeleton shape="text" width={160} />
            <Skeleton shape="pill" />
          </div>
        </div>
      </Section>

      <Section title="Unsaved changes bar">
        <div className="gl-gallery__wide gl-gallery__form">
          <Input title="Tagline" name={`tagline-${theme}`} id={`tagline-${theme}`} value={tagline} onChange={(e) => setTagline(e.target.value)} />
          <UnsavedChangesBar
            visible={tagline !== saved}
            message="You changed the tagline"
            onDiscard={() => setTagline(saved)}
            onSave={() => {
              setSaved(tagline)
              toast.success("Settings saved")
            }}
          />
        </div>
      </Section>

      <Section title="Sidebar (admin, contributor)">
        {SHELLS.map((s) => (
          <div key={s.role} className="gl-gallery__shell" role="group" aria-label={`Sidebar as ${s.role}`}>
            <SidebarNav sections={s.sections} current={s.current} />
          </div>
        ))}
      </Section>

      <Section title="Error pages">
        <div className="gl-gallery__wide">
          <div className="gl-gallery__frame">
            <NotFoundPage />
          </div>
          <div className="gl-gallery__frame">
            <ForbiddenPage area="Settings" />
          </div>
          <div className="gl-gallery__frame">
            <ServerErrorPage status={503} requestId="7f3a91c2-4e0b-4d6a-9c1e-2b8f5d3a6e10" onRetry={() => toast.info("Try again")} />
          </div>
        </div>
      </Section>

      <Modal
        isOpen={dialog}
        onClose={() => setDialog(false)}
        title="Invite people"
        footer={
          <>
            <Button variant="secondary" size="lg" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="lg" onClick={() => setDialog(false)}>
              Send invite
            </Button>
          </>
        }
      >
        <Input title="Email addresses" name={`invite-${theme}`} id={`invite-${theme}`} hint="Separate addresses with a comma or Enter." />
        <RadioGroup legend="Role" variant="card" options={ROLES} value={role} onChange={setRole} />
      </Modal>

      <Modal
        isOpen={confirm}
        onClose={() => setConfirm(false)}
        role="alertdialog"
        size="small"
        title="Delete this post?"
        description="It moves to Trash and comes off the site. You can restore it for 30 days."
        footer={
          <>
            <Button variant="secondary" size="lg" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="lg" onClick={() => setConfirm(false)}>
              Delete post
            </Button>
          </>
        }
      >
        {null}
      </Modal>

      <Drawer isOpen={drawer} onClose={() => setDrawer(false)} title="Version history" footer={<Button variant="primary">Restore version</Button>}>
        <div className="gl-gallery__stack">
          {["Today, 10:42 · Ana Costa", "Yesterday, 18:03 · Luan", "Oct 24, 09:15 · Marco Ruiz"].map((v) => (
            <Checkbox key={v} label={v} onChange={() => {}} />
          ))}
        </div>
      </Drawer>
    </div>
  )
}

export default function UiGallery() {
  return (
    <div className="gl-gallery">
      <header className="gl-gallery__header">
        <h1 className="gl-gallery__page-title">UI components</h1>
        <p className="gl-gallery__lead">
          Dev only (#338). Each component in both themes; dialogs and drawers open in the theme of the panel that opened them, toasts in the admin's
          current theme.
        </p>
      </header>
      <div className="gl-gallery__grid">
        <Panel theme="light" />
        <Panel theme="dark" />
      </div>
    </div>
  )
}
