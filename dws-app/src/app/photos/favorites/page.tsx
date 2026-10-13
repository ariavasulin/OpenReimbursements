import { redirect } from "next/navigation";

/** Favorites is a filter, not a page: the hearts live on every grid behind the Favorites chip. */
export default function FavoritesRedirect() {
  redirect("/photos?favorites=1");
}
