import SearchBar from "@/components/search/SearchBar";
import HeaderActions from "./HeaderActions";

export default function Header() {
  return (
    <header>
      <div className="header-left">
        <a href="/" className="header-logo-btn" aria-label="Volver al inicio">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/nj/logo.png" alt="Logo F&L" className="header-logo" />
        </a>
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
