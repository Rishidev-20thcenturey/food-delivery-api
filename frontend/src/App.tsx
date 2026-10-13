import { useCallback, useEffect, useMemo, useState } from "react";

type User = { id: string; name: string; email: string; role: string };
type Session = { accessToken: string; expiresIn: number; user: User };
type Restaurant = {
  id: string; name: string; description?: string | null; logoUrl?: string | null;
  coverUrl?: string | null; cuisines?: string[]; city?: string; postalCode?: string;
  isOpen?: boolean; ratingAverage?: number; ratingCount?: number;
  prepMinutes?: number; deliveryMinutes?: number; minOrderMinor?: number; deliveryFeeMinor?: number;
};
type MenuItem = { id: string; name: string; description?: string | null; imageUrl?: string | null; priceMinor: number; isVeg?: boolean | null; dietaryLabels?: string[]; isAvailable?: boolean };
type MenuCategory = { id: string; name: string; description?: string | null; items: MenuItem[] };
type CartItem = { id: string; menuItemId: string; name: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number; isAvailable: boolean };
type Cart = { restaurant: { id: string; name: string; isOpen: boolean } | null; items: CartItem[]; pricing: { subtotalMinor: number; deliveryFeeMinor: number; taxMinor: number; discountMinor: number; totalMinor: number; currency: string } | null; itemCount: number; warnings?: { code: string; message: string; cartItemId?: string }[] };
type Address = { id: string; label?: string | null; recipientName: string; recipientPhone: string; line1: string; city: string; state: string; postalCode: string; isDefault: boolean };
type Order = { id: string; orderNumber: string; status: string; restaurant: { name: string }; pricing: { totalMinor: number }; createdAt: string };

const API = "/api/v1";
const money = (minor = 0) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(minor / 100);
const initials = (name: string) => name.split(/\s+/).slice(0, 2).map((s) => s[0]).join("").toUpperCase();

async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API}${path}`, { ...init, headers, credentials: "include" });
  const body: any = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message || (response.status === 503 ? "The API is not configured yet." : "Something went wrong. Please try again.");
    throw new Error(message);
  }
  return (body?.data ?? body) as T;
}
const json = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });

export default function App() {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [selected, setSelected] = useState<Restaurant | null>(null);
  const [menu, setMenu] = useState<MenuCategory[]>([]);
  const [menuLoading, setMenuLoading] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [addressFormOpen, setAddressFormOpen] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState("");
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [lastOrder, setLastOrder] = useState<Order | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3500);
  }, []);

  const loadRestaurants = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: "1", limit: "50", sort: "rating" });
      if (q.trim()) params.set("q", q.trim());
      const result = await api<Restaurant[]>(`/restaurants?${params.toString()}`);
      setRestaurants(result);
    } catch (error) {
      setRestaurants([]);
      showToast(error instanceof Error ? error.message : "Could not load restaurants.");
    } finally { setLoading(false); }
  }, [showToast]);

  const loadCart = useCallback(async (authToken: string) => {
    try { setCart(await api<Cart>("/cart", {}, authToken)); }
    catch (error) { showToast(error instanceof Error ? error.message : "Could not load cart."); }
  }, [showToast]);

  const loadAddresses = useCallback(async (authToken: string) => {
    try {
      const result = await api<Address[]>("/me/addresses", {}, authToken);
      setAddresses(result);
      setSelectedAddress((prev) => prev || result.find((a) => a.isDefault)?.id || result[0]?.id || "");
    } catch { setAddresses([]); }
  }, []);

  useEffect(() => { void loadRestaurants(""); }, [loadRestaurants]);
  useEffect(() => {
    const handle = window.setTimeout(() => { void loadRestaurants(search); }, 220);
    return () => window.clearTimeout(handle);
  }, [search, loadRestaurants]);
  useEffect(() => {
    let alive = true;
    api<Session>("/auth/refresh", { method: "POST" })
      .then((session) => {
        if (!alive || !session?.accessToken) return;
        setToken(session.accessToken); setUser(session.user);
        void loadCart(session.accessToken); void loadAddresses(session.accessToken);
      })
      .catch(() => { /* a visitor without a refresh cookie is expected */ });
    return () => { alive = false; };
  }, [loadCart, loadAddresses]);

  const openRestaurant = async (restaurant: Restaurant) => {
    setSelected(restaurant); setMenu([]); setMenuLoading(true);
    try { setMenu(await api<MenuCategory[]>(`/restaurants/${restaurant.id}/menu`)); }
    catch (error) { showToast(error instanceof Error ? error.message : "Menu could not be loaded."); }
    finally { setMenuLoading(false); }
  };

  const addItem = async (item: MenuItem) => {
    if (!token) { setAuthMode("login"); setAuthOpen(true); showToast("Sign in to add items to your cart."); return; }
    const send = (replaceExistingCart = false) => api<Cart>("/cart/items", json({ menuItemId: item.id, quantity: 1, replaceExistingCart }), token);
    setBusy(true);
    try {
      setCart(await send(false)); showToast(`${item.name} added to your cart.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add item.";
      if (/different restaurant|another restaurant|cart/i.test(message) && window.confirm("Your cart has items from another restaurant. Replace them?")) {
        try { setCart(await send(true)); showToast(`${item.name} added to your cart.`); }
        catch (retryError) { showToast(retryError instanceof Error ? retryError.message : "Could not update cart."); }
      } else showToast(message);
    } finally { setBusy(false); }
  };

  const changeQuantity = async (line: CartItem, delta: number) => {
    if (!token) return;
    setBusy(true);
    try {
      if (line.quantity + delta <= 0) {
        setCart(await api<Cart>(`/cart/items/${line.id}`, { method: "DELETE" }, token));
      } else {
        setCart(await api<Cart>(`/cart/items/${line.id}`, { method: "PATCH", body: JSON.stringify({ quantity: line.quantity + delta }) }, token));
      }
    } catch (error) { showToast(error instanceof Error ? error.message : "Could not update cart."); }
    finally { setBusy(false); }
  };

  const afterAuth = async (session: Session) => {
    setToken(session.accessToken); setUser(session.user); setAuthOpen(false);
    await Promise.all([loadCart(session.accessToken), loadAddresses(session.accessToken)]);
    showToast(`Welcome, ${session.user.name.split(" ")[0]}!`);
  };

  const signOut = async () => {
    try { await api<null>("/auth/logout", { method: "POST" }, token ?? undefined); } catch { /* clear local state either way */ }
    setToken(null); setUser(null); setCart(null); setAddresses([]); setOrders([]); setOrdersOpen(false);
    showToast("You have signed out.");
  };

  const openOrders = async () => {
    if (!token) { setAuthOpen(true); return; }
    setOrdersOpen(true);
    try { setOrders(await api<Order[]>("/orders?page=1&limit=20", {}, token)); }
    catch (error) { showToast(error instanceof Error ? error.message : "Could not load orders."); }
  };

  const checkout = async () => {
    if (!token) { setAuthOpen(true); return; }
    if (!cart?.items.length) return;
    if (!addresses.length) { setAddressFormOpen(true); return; }
    if (!selectedAddress) { showToast("Choose a delivery address."); return; }
    setBusy(true);
    try {
      await api<unknown>("/checkout/preview", json({ addressId: selectedAddress }), token);
      const order = await api<Order>("/checkout", {
        ...json({ addressId: selectedAddress, paymentMethod: "COD" }),
        headers: { "Idempotency-Key": `crave-${crypto.randomUUID()}` },
      }, token);
      setLastOrder(order); setCartOpen(false); setCheckoutOpen(false); setSelected(null);
      setCart(await api<Cart>("/cart", {}, token));
      showToast("Your order has been placed.");
    } catch (error) { showToast(error instanceof Error ? error.message : "Checkout failed."); }
    finally { setBusy(false); }
  };

  const categories = useMemo(() => ["All", ...Array.from(new Set(restaurants.flatMap((r) => r.cuisines ?? []))).slice(0, 6)], [restaurants]);
  const [category, setCategory] = useState("All");
  const visibleRestaurants = useMemo(() => restaurants.filter((r) => category === "All" || r.cuisines?.includes(category)), [restaurants, category]);
  const cartCount = cart?.itemCount ?? 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="CraveDirect home" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
          <span className="brand-mark">c<span>.</span></span><span>crave<span className="brand-light">direct</span></span>
        </a>
        <div className="header-location"><span className="pin">⌖</span><span><small>Deliver to</small><strong>{addresses.find((a) => a.id === selectedAddress)?.city ?? "Your neighbourhood"}</strong></span><span className="chevron">⌄</span></div>
        <div className="header-actions">
          {user && <button className="nav-link" onClick={() => void openOrders()}>My orders</button>}
          <button className="cart-button" onClick={() => { if (!token && cartCount === 0) { setAuthOpen(true); return; } setCartOpen(true); }}><span className="cart-symbol">▱</span><span>Cart</span><b>{cartCount}</b></button>
          {user ? <button className="avatar-button" title={user.name} onClick={() => void signOut()}>{initials(user.name)}</button> : <button className="sign-in" onClick={() => { setAuthMode("login"); setAuthOpen(true); }}>Sign in</button>}
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-dot" /> GOOD FOOD, GOOD MOOD</div>
            <h1>Your cravings.<br /><em>Handled.</em></h1>
            <p>Local favourites, comfort classics, and new discoveries — brought right to your door.</p>
            <div className="hero-search"><span>⌕</span><input value={query} onChange={(e) => { setQuery(e.target.value); setSearch(e.target.value); }} placeholder="Dishes, restaurants, cuisines..." aria-label="Search restaurants" /><button onClick={() => setSearch(query)}>Find food <span>↗</span></button></div>
            <div className="hero-footnote"><span>✦</span> Find your next favourite, one bite at a time.</div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="hero-ring ring-one" /><div className="hero-ring ring-two" />
            <div className="hero-sun" />
            <div className="plate"><div className="plate-rim"><div className="food-bowl"><span className="food-leaf">✦</span><span className="food-tomato" /><span className="food-green" /><span className="food-orange" /><span className="food-herb">✳</span><span className="food-rice">···</span></div></div></div>
            <div className="floating-note note-top"><span>✹</span><div><strong>Made fresh</strong><small>Just for you</small></div></div>
            <div className="floating-note note-bottom"><span className="note-spark">↗</span><div><strong>Local love</strong><small>One delivery away</small></div></div>
            <div className="hero-stamp">GOOD<br />TASTE<br /><span>ONLY</span></div>
          </div>
          <div className="hero-bottomline"><span>THE NEIGHBOURHOOD'S TABLE</span><span>FRESH PICKS · HAPPY PLATES · EASY DAYS</span></div>
        </section>

        <section className="trust-strip">
          <div><span className="trust-icon">✳</span><span><strong>Made for your mood</strong><small>From quick bites to slow lunches</small></span></div>
          <div><span className="trust-icon">⌁</span><span><strong>Local spots, loved</strong><small>Your neighbourhood on a plate</small></span></div>
          <div><span className="trust-icon">♡</span><span><strong>Simple, every step</strong><small>Order online. Enjoy at home.</small></span></div>
        </section>

        <section className="catalogue" id="restaurants">
          <div className="section-heading"><div><div className="eyebrow small-eyebrow">YOUR NEXT GREAT MEAL</div><h2>What's on the menu<span>?</span></h2><p>Good things are cooking nearby.</p></div><div className="result-count">{loading ? "Finding spots…" : `${visibleRestaurants.length} places to explore`} <span>↘</span></div></div>
          <div className="filters"><div className="category-tabs">{categories.map((item) => <button key={item} className={category === item ? "category active" : "category"} onClick={() => setCategory(item)}>{item}</button>)}</div><button className="filter-search" onClick={() => document.querySelector<HTMLInputElement>(".hero-search input")?.focus()}>⌕ <span>Search places</span></button></div>
          {loading ? <div className="restaurant-grid">{[1,2,3].map((n) => <div className="restaurant-skeleton" key={n}><div /><span /><span /></div>)}</div> :
            visibleRestaurants.length ? <div className="restaurant-grid">
              {visibleRestaurants.map((r, index) => <button className="restaurant-card" key={r.id} onClick={() => void openRestaurant(r)}>
                <div className={`restaurant-art art-${index % 4}`}>
                  {r.coverUrl ? <img src={r.coverUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <><span className="art-orb" /><span className="art-food">{["🥘","🍜","🥗","🍛"][index % 4]}</span><span className="art-line">{(r.cuisines?.[0] ?? "MADE WITH LOVE").toUpperCase()}</span></>}
                  <span className="card-badge">{r.isOpen ? "OPEN NOW" : "CLOSED"}</span>
                </div>
                <div className="restaurant-details"><div className="restaurant-title"><h3>{r.name}</h3><span className="rating">★ {Number(r.ratingAverage ?? 0).toFixed(1)}</span></div><p>{r.cuisines?.join(" · ") || "Local favourites"}</p><div className="restaurant-meta"><span>◷ {r.deliveryMinutes ?? r.prepMinutes ?? 30}–{(r.deliveryMinutes ?? r.prepMinutes ?? 30) + 10} min</span><span>{money(r.deliveryFeeMinor)} delivery</span></div></div>
              </button>)}
            </div> : <div className="empty-state"><span>✳</span><h3>No places found just yet</h3><p>Try another dish, cuisine, or search term.</p><button className="secondary-button" onClick={() => { setQuery(""); setSearch(""); setCategory("All"); }}>Clear search</button></div>}
        </section>

        <section className="closing-banner"><div className="closing-spark">✦</div><div><div className="eyebrow">A LITTLE LOCAL MAGIC</div><h2>Good food brings us together.</h2><p>Every order supports the places that make a neighbourhood feel like home.</p></div><button onClick={() => document.getElementById("restaurants")?.scrollIntoView({ behavior: "smooth" })}>Explore the menu <span>↗</span></button></section>
      </main>

      <footer><a className="brand footer-brand" href="#"><span className="brand-mark">c<span>.</span></span><span>crave<span className="brand-light">direct</span></span></a><p>Good food. Close to home.</p><small>© {new Date().getFullYear()} CraveDirect · Made with local love.</small></footer>

      {toast && <div className="toast" role="status"><span>✦</span>{toast}</div>}

      {selected && <div className="overlay" onClick={() => setSelected(null)}><section className="modal menu-modal" onClick={(e) => e.stopPropagation()}>
        <button className="close-button" aria-label="Close menu" onClick={() => setSelected(null)}>×</button>
        <div className="modal-cover"><div className="modal-cover-art"><span>{selected.cuisines?.[0]?.toLowerCase().includes("ital") ? "🍝" : "🥘"}</span></div><div><div className="eyebrow small-eyebrow">TODAY'S FAVOURITE</div><h2>{selected.name}</h2><p>{selected.cuisines?.join(" · ") || "Freshly prepared favourites"}</p><div className="modal-stats"><span>★ {Number(selected.ratingAverage ?? 0).toFixed(1)}</span><span>◷ {selected.deliveryMinutes ?? 30} min</span><span>{money(selected.deliveryFeeMinor)} delivery</span></div></div></div>
        <div className="menu-content"><div className="menu-heading"><h3>The menu</h3><span>Prices in INR</span></div>
          {menuLoading ? <p className="muted">Loading the menu…</p> : menu.length ? menu.map((cat) => <div className="menu-category" key={cat.id}><h4>{cat.name}</h4>{cat.items.map((item) => <div className="menu-item" key={item.id}><div className="veg-dot" data-veg={item.isVeg === true ? "yes" : "no"} /><div className="menu-item-copy"><strong>{item.name}</strong><p>{item.description || (item.dietaryLabels ?? []).join(" · ") || "Prepared fresh when you order."}</p><b>{money(item.priceMinor)}</b></div><button disabled={!item.isAvailable || busy || !selected.isOpen} className="add-button" onClick={() => void addItem(item)}>{item.isAvailable === false ? "Sold out" : "+ Add"}</button></div>)}</div>) : !menuLoading && <div className="empty-menu"><span>🍽</span><p>There's no menu available right now. Check back soon.</p></div>}
        </div>
      </section></div>}

      {authOpen && <AuthModal mode={authMode} setMode={setAuthMode} close={() => setAuthOpen(false)} onSuccess={afterAuth} showToast={showToast} />}

      {cartOpen && <div className="overlay side-overlay" onClick={() => setCartOpen(false)}><aside className="cart-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-heading"><div><div className="eyebrow small-eyebrow">YOUR ORDER</div><h2>Your cart <span>({cartCount})</span></h2></div><button className="close-button" onClick={() => setCartOpen(false)} aria-label="Close cart">×</button></div>
        {!user ? <div className="empty-state"><span>♡</span><h3>Your next meal starts here</h3><p>Sign in to save your cart and place your order.</p><button className="primary-button" onClick={() => { setCartOpen(false); setAuthOpen(true); }}>Sign in</button></div> :
          !cart?.items.length ? <div className="empty-state"><span>🛍</span><h3>Your cart is taking a break</h3><p>Find something lovely to eat and add it here.</p><button className="secondary-button" onClick={() => setCartOpen(false)}>Explore restaurants</button></div> :
          <><div className="cart-restaurant"><span className="mini-mark">c.</span><div><strong>{cart.restaurant?.name}</strong><small>Made fresh for you</small></div><span>⌁</span></div><div className="cart-lines">{cart.items.map((line) => <div className="cart-line" key={line.id}><div className="cart-line-copy"><strong>{line.name}</strong><small>{money(line.unitPriceMinor)} each</small></div><div className="quantity-stepper"><button disabled={busy} onClick={() => void changeQuantity(line, -1)} aria-label="Remove one">−</button><span>{line.quantity}</span><button disabled={busy} onClick={() => void changeQuantity(line, 1)} aria-label="Add one">+</button></div><b>{money(line.lineTotalMinor)}</b></div>)}</div>
            {cart.warnings?.length ? <div className="cart-warning">{cart.warnings.map((w) => <p key={w.code}>{w.message}</p>)}</div> : null}
            <div className="cart-totals"><div><span>Subtotal</span><b>{money(cart.pricing?.subtotalMinor)}</b></div><div><span>Delivery</span><b>{money(cart.pricing?.deliveryFeeMinor)}</b></div><div><span>Taxes</span><b>{money(cart.pricing?.taxMinor)}</b></div><div className="total-row"><span>Estimated total</span><b>{money(cart.pricing?.totalMinor)}</b></div></div>
            <button className="primary-button checkout-cta" disabled={busy || !cart.restaurant?.isOpen || Boolean(cart.warnings?.length)} onClick={() => { setCartOpen(false); setCheckoutOpen(true); }}>{busy ? "Updating…" : "Continue to checkout"} <span>↗</span></button><p className="cod-note">Cash on delivery · No online payment is enabled.</p>
          </>}
      </aside></div>}

      {checkoutOpen && <div className="overlay" onClick={() => setCheckoutOpen(false)}><section className="modal checkout-modal" onClick={(e) => e.stopPropagation()}><button className="close-button" onClick={() => setCheckoutOpen(false)} aria-label="Close checkout">×</button><div className="eyebrow small-eyebrow">ALMOST THERE</div><h2>Where should we bring it?</h2><p className="muted">Choose a saved address for this delivery.</p>
        {addresses.length ? <div className="address-list">{addresses.map((a) => <button key={a.id} className={selectedAddress === a.id ? "address-option chosen" : "address-option"} onClick={() => setSelectedAddress(a.id)}><span className="radio-mark">{selectedAddress === a.id ? "●" : "○"}</span><span><strong>{a.label || "Delivery address"} {a.isDefault && <em>DEFAULT</em>}</strong><small>{a.recipientName} · {a.line1}, {a.city}, {a.state} {a.postalCode}</small></span></button>)}</div> : <div className="empty-address">You need to add a delivery address before placing an order.</div>}
        <button className="add-address-link" onClick={() => setAddressFormOpen((v) => !v)}>{addressFormOpen ? "− Cancel new address" : "+ Add a new address"}</button>
        {addressFormOpen && <AddressForm token={token!} onSaved={async (address) => { const updated = [...addresses, address]; setAddresses(updated); setSelectedAddress(address.id); setAddressFormOpen(false); showToast("Address saved."); }} showToast={showToast} />}
        <div className="checkout-summary"><span>Estimated total</span><strong>{money(cart?.pricing?.totalMinor)}</strong></div><div className="payment-choice"><span>Payment method</span><strong>Cash on delivery</strong><small>Pay when your order arrives.</small></div>
        <button className="primary-button checkout-cta" disabled={busy || !selectedAddress || !addresses.length} onClick={() => void checkout()}>{busy ? "Placing your order…" : "Place COD order"} <span>↗</span></button>
      </section></div>}

      {lastOrder && <div className="overlay" onClick={() => setLastOrder(null)}><section className="modal order-success" onClick={(e) => e.stopPropagation()}><button className="close-button" onClick={() => setLastOrder(null)} aria-label="Close order confirmation">×</button><span className="success-icon">✓</span><div className="eyebrow small-eyebrow">THAT'S A GOOD CHOICE</div><h2>Your order is in.</h2><p>Thanks for choosing local. Your restaurant will take it from here.</p><div className="order-reference"><span>ORDER NUMBER</span><strong>{lastOrder.orderNumber}</strong><small>{lastOrder.restaurant?.name} · {money(lastOrder.pricing?.totalMinor)} · Cash on delivery</small></div><button className="primary-button" onClick={() => { setLastOrder(null); void openOrders(); }}>Track your order <span>↗</span></button><button className="secondary-button" onClick={() => setLastOrder(null)}>Back to browsing</button></section></div>}

      {ordersOpen && <div className="overlay side-overlay" onClick={() => setOrdersOpen(false)}><aside className="cart-drawer orders-drawer" onClick={(e) => e.stopPropagation()}><div className="drawer-heading"><div><div className="eyebrow small-eyebrow">YOUR CRAVEDIRECT HISTORY</div><h2>My orders</h2></div><button className="close-button" onClick={() => setOrdersOpen(false)} aria-label="Close orders">×</button></div>{orders.length ? orders.map((o) => <div className="order-row" key={o.id}><span className="order-status">{o.status.replaceAll("_", " ")}</span><strong>{o.restaurant?.name}</strong><small>#{o.orderNumber} · {new Date(o.createdAt).toLocaleDateString("en-IN")}</small><b>{money(o.pricing?.totalMinor)}</b></div>) : <div className="empty-state"><span>♡</span><h3>No orders yet</h3><p>Your next favourite could be just around the corner.</p></div>}</aside></div>}
    </div>
  );
}

function AuthModal({ mode, setMode, close, onSuccess, showToast }: {
  mode: "login" | "register"; setMode: (mode: "login" | "register") => void; close: () => void;
  onSuccess: (session: Session) => Promise<void>; showToast: (message: string) => void;
}) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [submitting, setSubmitting] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setSubmitting(true);
    try {
      const session = await api<Session>(mode === "register" ? "/auth/register" : "/auth/login", json(mode === "register" ? { name, email, password } : { email, password }));
      await onSuccess(session);
    } catch (error) { showToast(error instanceof Error ? error.message : "Sign in failed."); }
    finally { setSubmitting(false); }
  };
  return <div className="overlay" onClick={close}><section className="modal auth-modal" onClick={(e) => e.stopPropagation()}><button className="close-button" onClick={close} aria-label="Close">×</button><span className="auth-mark">c.</span><div className="eyebrow small-eyebrow">{mode === "register" ? "COME ON IN" : "WELCOME BACK"}</div><h2>{mode === "register" ? "Good to meet you." : "Your table awaits."}</h2><p className="muted">{mode === "register" ? "Create your customer account to order local favourites." : "Sign in to pick up right where you left off."}</p><form onSubmit={(e) => void submit(e)}>{mode === "register" && <label>Your name<input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="What should we call you?" /></label>}<label>Email address<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label><label>Password<input required minLength={mode === "register" ? 8 : 1} maxLength={72} type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "register" ? "At least 8 characters" : "Your password"} /></label><button className="primary-button" disabled={submitting}>{submitting ? "One moment…" : mode === "register" ? "Create account" : "Sign in"} <span>↗</span></button></form><p className="auth-switch">{mode === "register" ? "Already have an account?" : "New to CraveDirect?"} <button onClick={() => setMode(mode === "register" ? "login" : "register")}>{mode === "register" ? "Sign in" : "Create account"}</button></p><small className="auth-footnote">Your account is customer-only. Restaurant and courier roles are assigned separately for safety.</small></section></div>;
}

function AddressForm({ token, onSaved, showToast }: {
  token: string; onSaved: (address: Address) => Promise<void>; showToast: (message: string) => void;
}) {
  const [form, setForm] = useState({ label: "Home", recipientName: "", recipientPhone: "", line1: "", city: "", state: "", postalCode: "" });
  const [saving, setSaving] = useState(false);
  const update = (key: keyof typeof form, value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true);
    try {
      const address = await api<Address>("/me/addresses", json({ ...form, country: "IN", isDefault: true }), token);
      await onSaved(address);
    } catch (error) { showToast(error instanceof Error ? error.message : "Could not save address."); }
    finally { setSaving(false); }
  };
  return <form className="address-form" onSubmit={(e) => void submit(e)}><label>Label<input required value={form.label} onChange={(e) => update("label", e.target.value)} /></label><div className="form-pair"><label>Recipient name<input required value={form.recipientName} onChange={(e) => update("recipientName", e.target.value)} /></label><label>Phone<input required inputMode="tel" pattern="\+?[0-9]{10,15}" value={form.recipientPhone} onChange={(e) => update("recipientPhone", e.target.value)} placeholder="10–15 digits" /></label></div><label>Address line<input required value={form.line1} onChange={(e) => update("line1", e.target.value)} placeholder="House, street, area" /></label><div className="form-pair"><label>City<input required value={form.city} onChange={(e) => update("city", e.target.value)} /></label><label>State<input required value={form.state} onChange={(e) => update("state", e.target.value)} /></label></div><label>PIN code<input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={form.postalCode} onChange={(e) => update("postalCode", e.target.value)} /></label><button className="secondary-button" disabled={saving}>{saving ? "Saving…" : "Save address"}</button></form>;
}
