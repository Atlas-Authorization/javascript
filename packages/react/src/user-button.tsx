'use client';

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useAuth, useSession, useSessionList, useUser } from './hooks';
import { collectByType, useClass, useClasses, useText } from './components-shared';

/**
 * §L3 prebuilt-component EXTENSION API (Clerk `<UserButton.MenuItems>` /
 * `<UserButton.Action>` / `<UserButton.Link>`).
 *
 * These are *descriptor* components: they render nothing on their own. A parent
 * (`<UserButton>`) walks its children, matches these by identity, and turns each
 * into a real menu entry it controls — so custom items sit inside the prebuilt
 * dropdown's markup/appearance rather than being bolted on outside it. This is
 * the same static-subcomponent pattern Clerk uses (`UserButton.Action`, etc.).
 */
export interface MenuActionProps {
  /** The row's text. */
  label: ReactNode;
  /** Optional leading icon/element. */
  labelIcon?: ReactNode;
  /** Invoked when the row is chosen. */
  onClick?: () => void;
}
export interface MenuLinkProps {
  label: ReactNode;
  labelIcon?: ReactNode;
  /** Where the row navigates. */
  href: string;
}
/** A container for custom `<UserButton.Action>` / `<UserButton.Link>` rows. Renders nothing itself. */
function UserButtonMenuItems(_props: { children?: ReactNode }): null {
  return null;
}
/** A custom action row inside `<UserButton.MenuItems>`. Renders nothing itself. */
function UserButtonAction(_props: MenuActionProps): null {
  return null;
}
/** A custom link row inside `<UserButton.MenuItems>`. Renders nothing itself. */
function UserButtonLink(_props: MenuLinkProps): null {
  return null;
}

type MenuEntry =
  | { kind: 'action'; props: MenuActionProps }
  | { kind: 'link'; props: MenuLinkProps };

function collectMenuEntries(children: ReactNode): MenuEntry[] {
  return collectByType<MenuEntry>(children, (el) => {
    if (el.type === UserButtonAction) return { kind: 'action', props: el.props as MenuActionProps };
    if (el.type === UserButtonLink) return { kind: 'link', props: el.props as MenuLinkProps };
    return undefined;
  });
}

/**
 * The signed-in user's avatar + dropdown. Pass `<UserButton.MenuItems>` children
 * to add custom `<UserButton.Action>` / `<UserButton.Link>` rows above sign-out.
 */
export function UserButton({ children }: { children?: ReactNode } = {}) {
  const cls = useClasses();
  const { user } = useUser();
  const { signOut } = useAuth();
  const { session } = useSession();
  const { sessions, setActive } = useSessionList();
  const t = useText();
  const [open, setOpen] = useState(false);

  const avatarClass = useClass('avatar', 'atlas-avatar');
  const menuClass = useClass('menu', 'atlas-menu');
  const itemClass = useClass('menuItem', 'atlas-menu-item');

  const custom = useMemo(() => collectMenuEntries(children), [children]);

  if (!user) return null;

  const label = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || '';
  const nameOf = (u: { first_name?: string | null; last_name?: string | null; username?: string | null }) =>
    [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
  // §L1 the OTHER accounts signed in on this browser (switchable in one click).
  const others = sessions.filter((s) => s.id !== session?.id);

  return (
    <div className={cls('userButton', 'atlas-user-button')}>
      <button className={avatarClass} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {user.image_url ? <img alt="" src={user.image_url} /> : <span>{label.slice(0, 1)}</span>}
      </button>

      {open ? (
        <div className={menuClass} role="menu">
          <span className={itemClass}>{label}</span>
          {/* §L1 switch to another signed-in account. */}
          {others.map((s) => (
            <button
              key={s.id}
              className={itemClass}
              role="menuitem"
              data-atlas="switch-session"
              onClick={() => {
                setOpen(false);
                void setActive({ session: s.id });
              }}
            >
              {s.user.image_url ? (
                <img alt="" src={s.user.image_url} width={16} height={16} />
              ) : null}
              {t('userButton.switchTo')} {nameOf(s.user)}
            </button>
          ))}
          {custom.map((entry, i) =>
            entry.kind === 'action' ? (
              <button
                key={i}
                className={itemClass}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  entry.props.onClick?.();
                }}
              >
                {entry.props.labelIcon}
                {entry.props.label}
              </button>
            ) : (
              <a key={i} className={itemClass} role="menuitem" href={entry.props.href}>
                {entry.props.labelIcon}
                {entry.props.label}
              </a>
            ),
          )}
          <button className={itemClass} role="menuitem" onClick={() => void signOut()}>
            {t('userButton.signOut')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
UserButton.MenuItems = UserButtonMenuItems;
UserButton.Action = UserButtonAction;
UserButton.Link = UserButtonLink;

/**
 * The signed-in user's avatar (image, or initials fallback) — the standalone
 * renderer `<UserButton>` uses internally, exported for reuse (Clerk `<UserAvatar>`).
 */
export function UserAvatar({ size = 32, className }: { size?: number; className?: string }) {
  const { user } = useUser();
  const avatarClass = useClass('avatar', 'atlas-avatar');
  if (!user) return null;
  const label = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || '';
  const style: CSSProperties = { width: size, height: size };
  return (
    <span className={className ?? avatarClass} style={style} data-atlas="user-avatar">
      {user.image_url ? <img alt="" src={user.image_url} width={size} height={size} /> : <span>{label.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}
