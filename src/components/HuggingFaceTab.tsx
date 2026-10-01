"use client";

/**
 * HuggingFace Tab Component
 *
 * Main component for the HuggingFace deployment interface.
 * Displays catalog items, search functionality, and deployment options.
 *
 * @module components/HuggingFaceTab
 */

import { useState, useEffect } from "react";
import type {
  CatalogItem,
  SearchResult,
  TabType,
  HfMemResult,
} from "./huggingface-tab/types";
import { MemoryModal } from "./huggingface-tab/MemoryModal";
import { LaunchConfigurator } from "@/app/dashboard/components/LaunchConfigurator";
import { ExistingInstanceInstallDialog } from "./huggingface-tab/ExistingInstanceInstallDialog";
import { ItemCard } from "./huggingface-tab/ItemCard";
import { FilterPanel } from "./huggingface-tab/FilterPanel";

interface HuggingFaceTabProps {
  token: string;
  onDeploymentStarted?: () => void;
}

export default function HuggingFaceTab({
  token,
  onDeploymentStarted,
}: HuggingFaceTabProps) {
  // Catalog
  const [activeTab, setActiveTab] = useState<TabType>("popular");
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  // PA-180: tracks whether the user has actually submitted a search, so we
  // can distinguish "no results for query" from "pre-search default browse".
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const [lastSearchQuery, setLastSearchQuery] = useState("");

  // Filters
  const [selectedTask, setSelectedTask] = useState<string>("");
  const [selectedLibrary, setSelectedLibrary] = useState<string>("");
  const [selectedParamSize, setSelectedParamSize] = useState<string>("");
  const [filterOptions, setFilterOptions] = useState<{
    tasks: Array<{ value: string; label: string }>;
    libraries: Array<{ value: string; label: string }>;
    paramSizes: Array<{ value: string; label: string }>;
  } | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  // Deploy modal
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState<
    CatalogItem | SearchResult | null
  >(null);
  const [existingInstallItem, setExistingInstallItem] = useState<CatalogItem | SearchResult | null>(null);

  // Memory modal state
  const [showMemoryModal, setShowMemoryModal] = useState(false);
  const [memoryModalData, setMemoryModalData] = useState<HfMemResult | null>(
    null
  );
  const [memoryModalLoading, setMemoryModalLoading] = useState(false);
  const [memoryCache, setMemoryCache] = useState<Record<string, HfMemResult>>(
    {}
  );


  // Fetch catalog when tab changes
  useEffect(() => {
    fetchCatalog(activeTab);
  }, [activeTab]);

  const fetchCatalog = async (type: TabType) => {
    setCatalogLoading(true);
    try {
      const res = await fetch(
        `/api/huggingface/catalog?type=${type}&checkCompatibility=true`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (res.ok) {
        const data = await res.json();
        setCatalogItems(data.items || []);
      }
    } catch (err) {
      console.error("Catalog error:", err);
    } finally {
      setCatalogLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || searchQuery.length < 2) return;

    setSearching(true);
    setSearchSubmitted(true);
    setLastSearchQuery(searchQuery);
    try {
      const params = new URLSearchParams({
        q: searchQuery,
        limit: "20",
      });
      if (selectedTask) params.append("task", selectedTask);
      if (selectedLibrary) params.append("library", selectedLibrary);
      if (selectedParamSize) params.append("paramSize", selectedParamSize);

      const res = await fetch(`/api/huggingface/search?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.results || []);
        if (data.filterOptions && !filterOptions) {
          setFilterOptions(data.filterOptions);
        }
      }
    } catch (err) {
      console.error("Search error:", err);
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchSubmitted(false);
    setLastSearchQuery("");
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


  // Fetch memory data for a model
  const fetchMemoryData = async (
    modelId: string
  ): Promise<HfMemResult | null> => {
    if (memoryCache[modelId]) {
      return memoryCache[modelId];
    }

    try {
      const res = await fetch(
        `/api/huggingface/model-memory?modelId=${encodeURIComponent(modelId)}`
      );
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data) {
          setMemoryCache((prev) => ({ ...prev, [modelId]: data.data }));
          return data.data;
        }
      }
    } catch (err) {
      console.error("Error fetching memory data:", err);
    }
    return null;
  };

  // Open memory modal
  const openMemoryModal = async (modelId: string) => {
    setShowMemoryModal(true);
    setMemoryModalLoading(true);
    setMemoryModalData(null);

    const data = await fetchMemoryData(modelId);
    setMemoryModalData(data);
    setMemoryModalLoading(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-[var(--fg)]">Hugging Face</h1>
      </div>

      {/* Search Bar */}
      <div className="mb-6">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Search Hugging Face Hub for models, spaces..."
              className="w-full px-4 py-2.5 pl-10 border border-[var(--line)] rounded-lg focus:ring-2 focus:ring-[var(--blue)] focus:border-transparent bg-white"
            />
            <svg
              className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-[var(--muted)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-4 py-2.5 border rounded-lg flex items-center gap-2 transition-colors ${
              showFilters || selectedTask || selectedLibrary || selectedParamSize
                ? "border-[var(--blue)] bg-blue-50 text-[var(--blue)]"
                : "border-[var(--line)] text-[var(--muted)] hover:bg-zinc-50"
            }`}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
              />
            </svg>
            <span>Filters</span>
            {(selectedTask || selectedLibrary || selectedParamSize) && (
              <span className="ml-1 bg-[var(--blue)] text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                {
                  [selectedTask, selectedLibrary, selectedParamSize].filter(
                    Boolean
                  ).length
                }
              </span>
            )}
          </button>
          <button
            onClick={handleSearch}
            disabled={searching || searchQuery.length < 2}
            className="px-5 py-2.5 bg-[var(--blue)] text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity font-medium"
          >
            {searching ? "..." : "Search"}
          </button>
          {(searchSubmitted || searchQuery.length > 0) && (
            <button
              onClick={clearSearch}
              className="px-4 py-2.5 text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Clear
            </button>
          )}
        </div>

        {/* Filter Panel */}
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
          <h2 className="text-lg font-semibold text-[var(--fg)] mb-4">
            Search Results ({searchResults.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {searchResults.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                onDeploy={openDeployModal}
                onInstallExisting={setExistingInstallItem}
                onOpenMemoryModal={openMemoryModal}
              />
            ))}
          </div>
        </div>
      ) : searchSubmitted && !searching ? (
        // PA-180: explicit empty state so users don't mistake the default
        // browse tabs below for "search returned irrelevant results".
        <div className="mb-8 text-center py-16 border border-dashed border-[var(--line)] rounded-xl">
          <h2 className="text-lg font-semibold text-[var(--fg)] mb-2">
            No models found for &ldquo;{lastSearchQuery}&rdquo;
          </h2>
          <p className="text-sm text-[var(--muted)] mb-4">
            Try a different name, broaden the query, or clear the filters.
          </p>
          <button
            onClick={clearSearch}
            className="px-4 py-2 text-sm text-[var(--blue)] hover:underline"
          >
            Clear search
          </button>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="mb-6">
            <div className="border-b border-[var(--line)]">
              <nav className="-mb-px flex space-x-6">
                {(["popular", "rtx", "model", "space"] as TabType[]).map(
                  (tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
                        activeTab === tab
                          ? "border-[var(--blue)] text-[var(--blue)]"
                          : "border-transparent text-[var(--muted)] hover:text-[var(--fg)] hover:border-zinc-300"
                      }`}
                    >
                      {tab === "popular"
                        ? "Popular"
                        : tab === "rtx"
                        ? "⚡ Pro 6000 Blackwell"
                        : tab === "model"
                        ? "All Models"
                        : "Spaces"}
                    </button>
                  )
                )}
              </nav>
            </div>
          </div>

          {/* Pro 6000 Blackwell Banner */}
          {activeTab === "rtx" && (
            <div className="mb-6 p-4 bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-xl">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                  <span className="text-xl">⚡</span>
                </div>
                <div>
                  <h3 className="font-semibold text-green-900">
                    Pro 6000 Blackwell Optimized
                  </h3>
                  <p className="text-sm text-green-700 mt-1">
                    These models are pre-configured for NVIDIA RTX PRO 6000
                    Blackwell GPUs with 96GB GDDR7 VRAM. Run 70B+ parameter
                    models with full precision. Optimized for fast inference
                    with vLLM. Perfect for production AI deployments.
                  </p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-full">
                      96GB VRAM
                    </span>
                    <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-full">
                      Blackwell Architecture
                    </span>
                    <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-full">
                      vLLM Optimized
                    </span>
                    <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-full">
                      70B+ Models
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Catalog Grid */}
          {catalogLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-4 border-[var(--blue)] border-t-transparent"></div>
            </div>
          ) : catalogItems.length === 0 ? (
            <div className="text-center py-12 text-[var(--muted)]">
              No items found in this category
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {catalogItems.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  onDeploy={openDeployModal}
                  onInstallExisting={setExistingInstallItem}
                  onOpenMemoryModal={openMemoryModal}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Launch the model with the complete reviewed resource configuration. */}
      {showDeployModal && selectedItem && (
        <LaunchConfigurator
          isOpen={showDeployModal}
          onClose={closeDeployModal}
          token={token}
          onSuccess={() => {
            closeDeployModal();
            onDeploymentStarted?.();
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

      {existingInstallItem && (
        <ExistingInstanceInstallDialog
          key={`${token}:${existingInstallItem.id}`}
          token={token}
          item={existingInstallItem}
          onClose={() => setExistingInstallItem(null)}
          onInstallationStarted={onDeploymentStarted}
        />
      )}

      {/* Memory Detail Modal */}
      {showMemoryModal && (
        <MemoryModal
          memoryData={memoryModalData}
          loading={memoryModalLoading}
          onClose={() => setShowMemoryModal(false)}
        />
      )}
    </div>
  );
}
