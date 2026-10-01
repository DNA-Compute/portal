"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import type {
  CatalogItem,
  SearchResult,
  FilterOptions,
  TabType,
} from "./types";
import { ItemCard } from "./ItemCard";
import { LaunchConfigurator } from "@/app/dashboard/components/LaunchConfigurator";
import { ExistingInstanceInstallDialog } from "@/components/huggingface-tab/ExistingInstanceInstallDialog";
import { FilterPanel } from "./FilterPanel";

function HuggingFacePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Auth
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Catalog
  const [activeTab, setActiveTab] = useState<TabType>("popular");
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Filters
  const [selectedTask, setSelectedTask] = useState<string>("");
  const [selectedLibrary, setSelectedLibrary] = useState<string>("");
  const [selectedParamSize, setSelectedParamSize] = useState<string>("");
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  // Deploy modal
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState<CatalogItem | SearchResult | null>(null);
  const [existingInstallItem, setExistingInstallItem] = useState<CatalogItem | SearchResult | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Check auth on mount
  useEffect(() => {
    const tokenFromUrl = searchParams.get("token");
    if (tokenFromUrl) {
      setToken(tokenFromUrl);
      setLoading(false);
    } else {
      router.push("/account");
    }
  }, [searchParams, router]);

  // Fetch catalog when tab changes
  useEffect(() => {
    if (!token) return;
    fetchCatalog(activeTab);
  }, [token, activeTab]);

  const fetchCatalog = async (type: TabType) => {
    setCatalogLoading(true);
    try {
      const res = await fetch(`/api/huggingface/catalog?type=${type}&checkCompatibility=true`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem("packet_token");
          router.push("/account");
          return;
        }
        throw new Error("Failed to fetch catalog");
      }
      const data = await res.json();
      setCatalogItems(data.items || []);
    } catch (err) {
      console.error("Catalog error:", err);
      setError("Failed to load catalog");
    } finally {
      setCatalogLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || searchQuery.length < 2) return;
    setSearching(true);
    try {
      const params = new URLSearchParams({ q: searchQuery, limit: "20" });
      if (selectedTask) params.append("task", selectedTask);
      if (selectedLibrary) params.append("library", selectedLibrary);
      if (selectedParamSize) params.append("paramSize", selectedParamSize);

      const res = await fetch(`/api/huggingface/search?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      setSearchResults(data.results || []);
      if (data.filterOptions) setFilterOptions(data.filterOptions);
    } catch (err) {
      console.error("Search error:", err);
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResults([]);
    setSelectedTask("");
    setSelectedLibrary("");
    setSelectedParamSize("");
    setShowFilters(false);
  };

  const openDeployModal = (item: CatalogItem | SearchResult) => {
    setSelectedItem(item);
    setShowDeployModal(true);
  };

  const closeDeployModal = () => {
    setShowDeployModal(false);
    setSelectedItem(null);
  };



  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-teal-500 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href={`/dashboard?token=${token}`} className="text-gray-500 hover:text-gray-700">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </Link>
              <div className="flex items-center gap-2">
                <span className="text-2xl">&#129303;</span>
                <h1 className="text-xl font-semibold text-gray-900">Hugging Face</h1>
              </div>
            </div>
            <Link
              href={`/dashboard?token=${token}`}
              className="hidden sm:block text-sm text-gray-600 hover:text-gray-900"
            >
              Back to Dashboard
            </Link>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="sm:hidden p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              {mobileMenuOpen ? (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          </div>
        </div>
        {mobileMenuOpen && (
          <div className="sm:hidden border-t border-gray-200 bg-white">
            <div className="px-4 py-3 space-y-2">
              <Link href={`/dashboard?token=${token}`} className="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded-lg" onClick={() => setMobileMenuOpen(false)}>Dashboard</Link>
              <Link href={`/dashboard?token=${token}&tab=instances`} className="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded-lg" onClick={() => setMobileMenuOpen(false)}>My GPUs</Link>
              <Link href={`/dashboard?token=${token}&tab=billing`} className="block px-3 py-2 text-gray-700 hover:bg-gray-100 rounded-lg" onClick={() => setMobileMenuOpen(false)}>Billing</Link>
            </div>
          </div>
        )}
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Search Bar */}
        <div className="mb-8">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder="Search Hugging Face Hub for models, spaces..."
                className="w-full px-4 py-3 pl-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
              />
              <svg className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`px-4 py-3 border rounded-lg transition-colors flex items-center gap-2 ${
                showFilters || selectedTask || selectedLibrary || selectedParamSize
                  ? "border-teal-500 text-teal-600 bg-teal-50"
                  : "border-gray-300 text-gray-600 hover:border-gray-300"
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              <span className="hidden sm:inline">Filters</span>
              {(selectedTask || selectedLibrary || selectedParamSize) && (
                <span className="w-2 h-2 bg-teal-500 rounded-full"></span>
              )}
            </button>
            <button
              onClick={handleSearch}
              disabled={searching || searchQuery.length < 2}
              className="px-6 py-3 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {searching ? "Searching..." : "Search"}
            </button>
            {searchResults.length > 0 && (
              <button onClick={clearSearch} className="px-4 py-3 text-gray-600 hover:text-gray-900">
                Clear
              </button>
            )}
          </div>

          {showFilters && (
            <FilterPanel
              selectedTask={selectedTask}
              setSelectedTask={setSelectedTask}
              selectedLibrary={selectedLibrary}
              setSelectedLibrary={setSelectedLibrary}
              selectedParamSize={selectedParamSize}
              setSelectedParamSize={setSelectedParamSize}
              filterOptions={filterOptions}
            />
          )}
        </div>

        {/* Search Results */}
        {searchResults.length > 0 ? (
          <div className="mb-8">
            <h2 className="text-lg font-medium text-gray-900 mb-4">
              Search Results ({searchResults.length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {searchResults.map((item) => (
                <ItemCard key={item.id} item={item} onDeploy={openDeployModal} onInstallExisting={setExistingInstallItem} />
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="mb-6">
              <div className="border-b border-gray-200">
                <nav className="-mb-px flex space-x-8">
                  {(["popular", "model", "docker", "space"] as TabType[]).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`py-4 px-1 border-b-2 font-medium text-sm ${
                        activeTab === tab
                          ? "border-teal-500 text-teal-600"
                          : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                      }`}
                    >
                      {tab === "popular" ? "Popular" : tab === "model" ? "Models" : tab === "docker" ? "Docker Images" : "Spaces"}
                    </button>
                  ))}
                </nav>
              </div>
            </div>

            {/* Catalog Grid */}
            {catalogLoading ? (
              <div className="flex justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-4 border-teal-500 border-t-transparent"></div>
              </div>
            ) : catalogItems.length === 0 ? (
              <div className="text-center py-12 text-gray-500">No items found in this category</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {catalogItems.map((item) => (
                  <ItemCard key={item.id} item={item} onDeploy={openDeployModal} onInstallExisting={setExistingInstallItem} />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* Launch the model with the complete reviewed resource configuration. */}
      {showDeployModal && selectedItem && (
        <LaunchConfigurator
          isOpen={showDeployModal}
          onClose={closeDeployModal}
          token={token || ""}
          onSuccess={() => {
            closeDeployModal();
            router.push(`/dashboard?token=${encodeURIComponent(token || "")}&tab=huggingface`);
          }}
          deployContext={{
            type: "huggingface",
            title: `Deploy ${selectedItem.name}`,
            subtitle: selectedItem.description,
            modelId: selectedItem.id,
            isGated: "gated" in selectedItem && selectedItem.gated,
            vramGb: "vramGb" in selectedItem ? selectedItem.vramGb : undefined,
          }}
        />
      )}

      {existingInstallItem && token && (
        <ExistingInstanceInstallDialog
          key={`${token}:${existingInstallItem.id}`}
          token={token}
          item={existingInstallItem}
          onClose={() => setExistingInstallItem(null)}
          onInstallationStarted={() => router.push(`/dashboard?token=${encodeURIComponent(token)}&tab=instances`)}
        />
      )}

    </div>
  );
}

function LoadingFallback() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-4 border-teal-500 border-t-transparent"></div>
    </div>
  );
}

export default function HuggingFacePage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <HuggingFacePageContent />
    </Suspense>
  );
}
