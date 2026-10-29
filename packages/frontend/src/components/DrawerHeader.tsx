/**
 * The top of the drawer: the companion's picture in a 40px ring (ring in the skin's trim colour) and their name.
 * One companion today, so this is the whole top of the menu. It is its own component so a list of companions
 * (rooms) can replace it later; it takes no props and reads the identity store only.
 */
import { useIdentity, avatarSrc } from '../store/identity';

export function DrawerHeader() {
  const identity = useIdentity();
  return (
    <div className="drawer-head">
      <span className="drawer-head-ring">
        <img src={avatarSrc(identity)} alt="" width={40} height={40} />
      </span>
      <span className="drawer-head-name">{identity.companion_name}</span>
    </div>
  );
}
