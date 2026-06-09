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
        <svg
          className="search-icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <SearchBar />
      </div>
      <div className="header-right">
        <HeaderActions />
      </div>
    </header>
  );
}
