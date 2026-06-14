import Link from "next/link";
import SearchBar from "@/components/search/SearchBar";
import HeaderActions from "./HeaderActions";
import { BASE_PATH } from "@/lib/constants/app";

export default function Header() {
  return (
    <header>
      <div className="header-left">
        <Link href="/" className="header-logo-btn" aria-label="Volver al inicio">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_PATH}/logo.png`} alt="Logo F&L" className="header-logo" />
        </Link>
      </div>
      <div className="search-bar-wrapper">
        <SearchBar />
      </div>
      <div className="header-right">
        <HeaderActions />
      </div>
    </header>
  );
}
