/* quote.js — Lakeside Ink & Threadz quote calculator (vanilla rebuild of the
   Mocha React wizard). Self-contained. Mounts at #lit-quote.

   Pricing logic, copy, and step flow mirror the original TSX 1:1; only the
   React/lucide-react/PlacementDiagrams dependencies were replaced with vanilla
   DOM + inline SVG. POSTs the same JSON shape to /api/submit-quote.
*/
(function () {
  'use strict';

  // ============== Pricing constants (verbatim from original) ==============
  const PRICING = {
    embroideryBase: { hats: 13.0, tshirts: 10.0, hoodies: 11.0, patches: 7.0, bags: 5.0 },
    volumeDiscounts: [
      { min: 1,   max: 11,   discount: 0.00, perPiece: 10.00 },
      { min: 12,  max: 23,   discount: 0.08, perPiece: 9.20  },
      { min: 24,  max: 47,   discount: 0.14, perPiece: 8.60  },
      { min: 48,  max: 99,   discount: 0.20, perPiece: 8.00  },
      { min: 100, max: 9999, discount: 0.25, perPiece: 7.50  },
    ],
    tierMultipliers: { standard: 1.0, pro: 1.2, premium: 1.4 },
    digitizing: 45.0,
    individualNames: 3.0,
    rushSurcharge: 0.25,
    logoDesign: 149.0,
  };

  const PRODUCTS = [
    { id: 'hats',     emoji: '🧢', name: 'Hats',                 desc: 'Snapbacks, flexfits, truckers, beanies', startPrice: 13 },
    { id: 'tshirts',  emoji: '👕', name: 'T-Shirts',             desc: 'Cotton, blends, performance tees',       startPrice: 10 },
    { id: 'hoodies',  emoji: '🧥', name: 'Hoodies & Sweatshirts', desc: 'Pullover and zip-up',                    startPrice: 11 },
    { id: 'patches',  emoji: '🪡', name: 'Patches',              desc: 'Sew-on and iron-on',                     startPrice: 7  },
    { id: 'bags',     emoji: '🎒', name: 'Bags & Promo Items',    desc: 'Totes, koozies, accessories',            startPrice: 5  },
  ];

  const QUANTITY_PRESETS = [
    { value: 6,   label: '1–11', subtext: 'Single run',     perPiece: 10.00, discount: 0,  featured: false },
    { value: 12,  label: '12',   subtext: 'Minimum bulk',   perPiece: 9.20,  discount: 8,  featured: false },
    { value: 24,  label: '24',   subtext: 'Most popular',   perPiece: 8.60,  discount: 14, featured: true  },
    { value: 48,  label: '48',   subtext: 'Volume pricing', perPiece: 8.00,  discount: 20, featured: false },
    { value: 100, label: '100+', subtext: 'Best rate',      perPiece: 7.50,  discount: 25, featured: false },
  ];

  const COLOR_OPTIONS = [
    { id: 'black',  name: 'Black',         hex: '#1a1a1a' },
    { id: 'white',  name: 'White',         hex: '#ffffff' },
    { id: 'navy',   name: 'Navy Blue',     hex: '#1e3a5f' },
    { id: 'gray',   name: 'Heather Gray',  hex: '#9ca3af' },
    { id: 'red',    name: 'Red',           hex: '#dc2626' },
    { id: 'royal',  name: 'Royal Blue',    hex: '#2563eb' },
    { id: 'green',  name: 'Forest Green',  hex: '#166534' },
    { id: 'maroon', name: 'Maroon',        hex: '#7f1d1d' },
    { id: 'orange', name: 'Orange',        hex: '#ea580c' },
    { id: 'pink',   name: 'Pink',          hex: '#ec4899' },
    { id: 'camo',   name: 'Camo',          hex: '#4a5d23' },
    { id: 'custom', name: 'Other / Mixed', hex: 'multi'   },
  ];

  const PLACEMENT_OPTIONS = {
    hats: [
      { id: 'front', name: 'Front panel', price: 0, included: true },
      { id: 'left',  name: 'Left side',   price: 4 },
      { id: 'right', name: 'Right side',  price: 4 },
      { id: 'back',  name: 'Back',        price: 4 },
    ],
    tshirts: [
      { id: 'frontChest',  name: 'Front chest',   price: 0, included: true },
      { id: 'fullFront',   name: 'Full front',    price: 3 },
      { id: 'back',        name: 'Back',          price: 5 },
      { id: 'leftSleeve',  name: 'Left sleeve',   price: 3 },
      { id: 'rightSleeve', name: 'Right sleeve',  price: 3 },
    ],
    hoodies: [
      { id: 'frontChest',  name: 'Front chest',   price: 0, included: true },
      { id: 'fullFront',   name: 'Full front',    price: 3 },
      { id: 'back',        name: 'Back',          price: 5 },
      { id: 'leftSleeve',  name: 'Left sleeve',   price: 3 },
      { id: 'rightSleeve', name: 'Right sleeve',  price: 3 },
    ],
    patches: [
      { id: 'standard',  name: 'Standard size', price: 0, included: true },
      { id: 'oversized', name: 'Oversized',     price: 2 },
    ],
    bags: [
      { id: 'front', name: 'Front', price: 0, included: true },
      { id: 'back',  name: 'Back',  price: 4 },
    ],
  };

  const ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.pdf', '.ai', '.eps', '.svg'];
  const TOTAL_STEPS = 8;

  // ============== Inline SVG icons (subset of lucide used) ==============
  const ICON = (path, opts) => {
    const o = opts || {};
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.size || 16}" height="${o.size || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${o.sw || 2}" stroke-linecap="round" stroke-linejoin="round" class="${o.cls || ''}" aria-hidden="true">${path}</svg>`;
  };
  const ICONS = {
    check:        (s) => ICON('<path d="M20 6L9 17l-5-5"/>', { size: s }),
    chevronLeft:  (s) => ICON('<polyline points="15 18 9 12 15 6"/>', { size: s }),
    x:            (s) => ICON('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', { size: s }),
    fileText:     (s) => ICON('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', { size: s }),
    penTool:      (s) => ICON('<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>', { size: s }),
    zap:          (s) => ICON('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>', { size: s }),
    user:         (s) => ICON('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', { size: s }),
    refresh:      (s) => ICON('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>', { size: s }),
    cloud:        (s) => ICON('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>', { size: s }),
    msgCircle:    (s) => ICON('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>', { size: s }),
  };

  // ============== Tiny SVG placement indicator (substitute for PlacementDiagram) ==============
  const PLACEMENT_SVG = {
    hats: {
      front: silhouetteHat(['front']),  left: silhouetteHat(['left']),
      right: silhouetteHat(['right']),  back: silhouetteHat(['back']),
    },
    tshirts: {
      frontChest:  silhouetteShirt(['frontChest']),
      fullFront:   silhouetteShirt(['fullFront']),
      back:        silhouetteShirt(['back']),
      leftSleeve:  silhouetteShirt(['leftSleeve']),
      rightSleeve: silhouetteShirt(['rightSleeve']),
    },
    hoodies: {
      frontChest:  silhouetteShirt(['frontChest'], true),
      fullFront:   silhouetteShirt(['fullFront'], true),
      back:        silhouetteShirt(['back'], true),
      leftSleeve:  silhouetteShirt(['leftSleeve'], true),
      rightSleeve: silhouetteShirt(['rightSleeve'], true),
    },
    patches: {
      standard:  silhouettePatch('standard'),
      oversized: silhouettePatch('oversized'),
    },
    bags: {
      front: silhouetteBag('front'),
      back:  silhouetteBag('back'),
    },
  };
  function silhouetteHat(highlight) {
    const dot = (x, y, on) => `<circle cx="${x}" cy="${y}" r="3.5" fill="${on?'#F09600':'transparent'}"/>`;
    return `<svg viewBox="0 0 60 50" width="56" height="46" aria-hidden="true">
      <path d="M10 32 Q30 8 50 32 L50 38 L10 38 Z" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="1.2"/>
      <rect x="6" y="38" width="48" height="4" rx="1" fill="#9CA3AF"/>
      ${dot(30,28,highlight.includes('front'))}
      ${dot(14,30,highlight.includes('left'))}
      ${dot(46,30,highlight.includes('right'))}
      ${dot(30,42,highlight.includes('back'))}
    </svg>`;
  }
  function silhouetteShirt(highlight, hoodie) {
    const dot = (x, y, on) => `<circle cx="${x}" cy="${y}" r="3" fill="${on?'#F09600':'transparent'}"/>`;
    const hood = hoodie ? '<path d="M22 6 Q30 2 38 6 L40 12 L20 12 Z" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="1"/>' : '';
    return `<svg viewBox="0 0 60 60" width="56" height="56" aria-hidden="true">
      ${hood}
      <path d="M14 14 L22 10 Q30 18 38 10 L46 14 L50 22 L42 24 L42 52 L18 52 L18 24 L10 22 Z" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="1.2"/>
      ${dot(24,22,highlight.includes('frontChest'))}
      ${highlight.includes('fullFront') ? '<rect x="22" y="22" width="16" height="22" fill="#F09600" opacity="0.45"/>' : ''}
      ${highlight.includes('back') ? '<rect x="22" y="22" width="16" height="24" fill="#F09600" opacity="0.45"/>' : ''}
      ${dot(14,20,highlight.includes('leftSleeve'))}
      ${dot(46,20,highlight.includes('rightSleeve'))}
    </svg>`;
  }
  function silhouettePatch(size) {
    const big = size === 'oversized';
    return `<svg viewBox="0 0 60 60" width="56" height="56" aria-hidden="true">
      <rect x="${big?8:16}" y="${big?8:16}" width="${big?44:28}" height="${big?44:28}" rx="6" fill="#F09600" opacity="0.85" stroke="#9CA3AF" stroke-width="1.2"/>
    </svg>`;
  }
  function silhouetteBag(side) {
    return `<svg viewBox="0 0 60 60" width="56" height="56" aria-hidden="true">
      <path d="M18 20 Q22 10 30 10 Q38 10 42 20" fill="none" stroke="#9CA3AF" stroke-width="1.5"/>
      <rect x="12" y="20" width="36" height="32" rx="2" fill="#E5E7EB" stroke="#9CA3AF" stroke-width="1.2"/>
      <circle cx="30" cy="34" r="4" fill="${side==='front'?'#F09600':'transparent'}" stroke="${side==='back'?'#F09600':'transparent'}" stroke-width="2"/>
      ${side==='back'?'<text x="30" y="38" text-anchor="middle" font-size="6" fill="#6B7280">back</text>':''}
    </svg>`;
  }

  // ============== State ==============
  const initialState = () => ({
    product: null,
    quantity: 0,
    customQuantity: false,
    showCustomQty: false,
    logoFile: null,        // {name, size}
    needsLogoDesign: false,
    skipLogo: false,
    productTier: 'standard',
    selectedColor: '',
    placements: [],
    addons: { individualNames: false, rushOrder: false, logoDesign: false },
    contact: { firstName: '', email: '', phone: '', businessName: '' },
    currentStep: 1,
    direction: 'forward',
    isAnimating: false,
    isDragging: false,
    isSubmitting: false,
    isSubmitted: false,
    fieldValidation: {},
    prevTotal: 0,
    priceAnimating: false,
  });
  let state = initialState();
  let root = null;

  // ============== Pricing math (verbatim) ==============
  function calculateEstimate() {
    if (!state.product || !state.quantity) return { perPiece: 0, total: 0, oneTimeFees: 0 };
    const basePrice = PRICING.embroideryBase[state.product];
    const tier = PRICING.volumeDiscounts.find(t => state.quantity >= t.min && state.quantity <= t.max) || PRICING.volumeDiscounts[0];
    const discountedBase = basePrice * (1 - tier.discount);
    const tierMult = PRICING.tierMultipliers[state.productTier];
    let perPiece = discountedBase * tierMult;
    const placementCost = state.placements.reduce((sum, id) => {
      const p = (PLACEMENT_OPTIONS[state.product] || []).find(x => x.id === id);
      return sum + (p ? p.price : 0);
    }, 0);
    perPiece += placementCost;
    if (state.addons.individualNames) perPiece += PRICING.individualNames;
    if (state.addons.rushOrder) perPiece *= 1 + PRICING.rushSurcharge;
    const subtotal = perPiece * state.quantity;
    let oneTimeFees = 0;
    if (!state.skipLogo) oneTimeFees += PRICING.digitizing;
    if (state.needsLogoDesign || state.addons.logoDesign) oneTimeFees += PRICING.logoDesign;
    return {
      perPiece: Math.round(perPiece * 100) / 100,
      total: Math.round((subtotal + oneTimeFees) * 100) / 100,
      oneTimeFees,
    };
  }
  function calculateSavings(qty) {
    if (!state.product) return 0;
    const base = PRICING.embroideryBase[state.product];
    const t = PRICING.volumeDiscounts.find(x => qty >= x.min && qty <= x.max) || PRICING.volumeDiscounts[0];
    return Math.round((base - base * (1 - t.discount)) * qty);
  }

  // ============== Render helpers ==============
  function h(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function set(partial, opts) {
    Object.assign(state, partial);
    render(opts && opts.skipAnim);
  }
  function goToStep(step, dir) {
    if (state.isAnimating || step < 1 || step > TOTAL_STEPS) return;
    state.direction = dir || 'forward';
    state.isAnimating = true;
    render();
    setTimeout(() => {
      state.currentStep = step;
      render();
      setTimeout(() => { state.isAnimating = false; render(); }, 40);
    }, 220);
  }
  function autoAdvance(next, delay) {
    setTimeout(() => goToStep(next, 'forward'), delay || 350);
  }

  function progressBar() {
    const bars = Array.from({ length: TOTAL_STEPS }, (_, i) => {
      const filled = i < state.currentStep;
      return `<div class="h-1.5 flex-1 rounded-full transition-all duration-300" style="background:${filled?'linear-gradient(90deg,#F09600,#E10078)':'#E5E5E5'}"></div>`;
    }).join('');
    return `<div class="mb-6">
      <div class="flex gap-1">${bars}</div>
      <div class="flex justify-end mt-2"><span class="text-[13px] text-[#999]">Step ${state.currentStep} of ${TOTAL_STEPS}</span></div>
    </div>`;
  }
  function backButton() {
    if (state.currentStep > 1) {
      return `<div class="mb-4 h-6"><button data-act="back" class="flex items-center gap-1 text-[#001E78] text-sm hover:opacity-70 transition-opacity">${ICONS.chevronLeft(16)} Back</button></div>`;
    }
    return `<div class="mb-4 h-6"><a href="/contact" class="flex items-center gap-1 text-[#001E78] text-sm hover:opacity-70 transition-opacity">${ICONS.msgCircle(14)} Need help? Text us →</a></div>`;
  }
  function priceTicker(est) {
    if (state.currentStep < 3 || est.total === 0) return '';
    const pulse = state.priceAnimating ? 'scale-110' : 'scale-100';
    return `<div class="bg-[#001E78] h-12 rounded-lg flex items-center justify-between px-4 mt-6 -mx-1">
      <span class="text-white/70 text-xs hidden sm:block">Your estimate so far:</span>
      <div class="hidden sm:flex items-center gap-2 transition-transform duration-300 ${pulse}">
        <span class="text-white font-bold text-lg">$${est.total.toFixed(2)}</span>
      </div>
      <span class="text-white/70 text-xs hidden sm:block">$${est.perPiece.toFixed(2)}/piece</span>
      <div class="sm:hidden flex-1 flex items-center justify-center gap-2">
        <span class="text-white font-bold text-lg transition-transform duration-300 ${pulse}">$${est.total.toFixed(0)}</span>
        <span class="text-white/60 text-xs">·</span>
        <span class="text-white/80 text-sm">$${est.perPiece.toFixed(2)}/ea</span>
      </div>
    </div>`;
  }

  // ============== Step renderers ==============
  function step1() {
    const cards = PRODUCTS.map((p, i) => {
      const sel = state.product === p.id;
      const last = i === PRODUCTS.length - 1;
      const cls = (sel
        ? 'border-[2.5px] border-[#001E78] bg-[#F0F4FF] scale-[1.02]'
        : 'border-[1.5px] border-[#001E78] bg-white hover:border-2 hover:bg-[#F0F4FF] hover:-translate-y-0.5');
      const check = sel ? `<div class="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#F09600] flex items-center justify-center text-white">${ICONS.check(12)}</div>` : '';
      return `<button data-act="product" data-id="${p.id}" class="relative p-4 min-h-[130px] rounded-[14px] text-center transition-all duration-200 flex flex-col items-center justify-center ${last?'col-span-2 max-w-[200px] mx-auto':''} ${cls}">
        ${check}
        <span class="text-4xl mb-2">${p.emoji}</span>
        <span class="font-bold text-[16px] text-[#001E78]">${p.name}</span>
        <span class="text-[13px] text-gray-500 mt-1">${p.desc}</span>
        <span class="text-[12px] text-[#F09600] mt-2">from $${p.startPrice}/piece</span>
      </button>`;
    }).join('');
    return `<div>
      <h3 class="text-xl md:text-2xl font-bold text-[#001E78] mb-2">What are we making for you?</h3>
      <p class="text-[15px] text-gray-500 mb-6">Pick your product and we'll build your price in real time.</p>
      <div class="grid grid-cols-2 gap-3">${cards}</div>
      <p class="text-center text-[12px] text-gray-400 mt-6">All prices include artwork review. No surprise fees.</p>
      <p class="text-center text-[13px] text-gray-500 mt-4">⭐ Trusted by Coats Contracting, Lake Life Foundation, Allen Dumpster Rental &amp; dozens more local businesses</p>
    </div>`;
  }
  function step2() {
    const savings = calculateSavings(state.quantity);
    const presets = QUANTITY_PRESETS.map(p => {
      const sel = !state.customQuantity && (
        (p.value === 6   && state.quantity >= 1   && state.quantity <= 11) ||
        (p.value === 12  && state.quantity === 12) ||
        (p.value === 24  && state.quantity === 24) ||
        (p.value === 48  && state.quantity === 48) ||
        (p.value === 100 && state.quantity >= 100)
      );
      const featured = p.featured;
      const base = featured
        ? 'bg-[#FFF8E7] border-[2.5px] border-[#001E78] min-h-[90px] sm:min-h-[110px]'
        : 'bg-white border-[1.5px] border-[#001E78] min-h-[80px] sm:min-h-[100px]';
      const selCls = sel
        ? 'border-[2.5px] border-[#001E78] bg-[#F0F4FF] scale-[1.02]'
        : 'hover:border-[#F09600] hover:bg-[#FFF8E7]';
      const pop = featured ? `<span class="absolute -top-2.5 left-1/2 -translate-x-1/2 px-1.5 sm:px-2 py-0.5 bg-[#F09600] text-white text-[9px] sm:text-[11px] font-semibold rounded-full whitespace-nowrap">Popular ⭐</span>` : '';
      const save = p.discount > 0 ? `<span class="text-[10px] sm:text-[11px] text-green-600">Save ${p.discount}%</span>` : '';
      return `<button data-act="qty" data-q="${p.value}" class="relative flex flex-col items-center justify-center p-2 sm:p-3 rounded-xl text-center transition-all duration-200 ${base} ${selCls}">
        ${pop}
        <span class="font-bold text-[22px] sm:text-[28px] text-[#001E78]">${p.label}</span>
        <span class="text-[10px] sm:text-[12px] text-gray-500 hidden sm:block">${p.subtext}</span>
        <span class="text-[12px] sm:text-[14px] font-bold text-[#F09600] mt-0.5 sm:mt-1">$${p.perPiece.toFixed(2)}/ea</span>
        ${save}
      </button>`;
    }).join('');

    const savingsLine = state.quantity > 0 && savings > 0
      ? `<p class="text-center text-[14px] text-green-600 mb-4">At ${state.quantity} pieces you save $${savings} vs. ordering one at a time.</p>` : '';

    const custom = !state.showCustomQty
      ? `<button data-act="showCustomQty" class="block mx-auto text-[#001E78] text-sm hover:underline">Enter a different number →</button>`
      : `<div class="mt-4 p-4 bg-gray-50 rounded-xl max-w-xs mx-auto">
          <div class="flex items-center justify-center gap-3">
            <button data-act="qtyMinus" class="w-12 h-12 rounded-lg border-2 border-[#001E78] text-[#001E78] font-bold text-xl hover:bg-[#F0F4FF] transition-colors">−</button>
            <input data-act="qtyInput" type="number" min="1" max="500" value="${state.quantity || ''}" class="w-20 h-12 text-center text-xl font-bold border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#001E78]/50"/>
            <button data-act="qtyPlus" class="w-12 h-12 rounded-lg border-2 border-[#001E78] text-[#001E78] font-bold text-xl hover:bg-[#F0F4FF] transition-colors">+</button>
          </div>
          ${state.quantity > 0 ? '<button data-act="qtyContinue" class="mt-4 w-full py-3 bg-[#001E78] text-white font-semibold rounded-lg hover:bg-[#001E78]/90 transition-colors">Continue →</button>' : ''}
        </div>`;

    return `<div>
      <h3 class="text-xl md:text-2xl font-bold text-[#001E78] mb-2">How many pieces are you thinking?</h3>
      <p class="text-[15px] text-gray-500 mb-6">Don't worry — you can always adjust later.</p>
      <div class="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-4">${presets}</div>
      ${savingsLine}
      ${custom}
    </div>`;
  }
  function step3() {
    const file = state.logoFile;
    const dz = !file
      ? `<div data-act="dropzone" class="relative border rounded-xl p-4 h-[100px] flex items-center justify-center gap-4 cursor-pointer transition-all duration-200 ${state.isDragging?'border-2 border-[#F09600] bg-[#FFFBF0]':'border border-[#E0E0E0] bg-[#FAFAFA] hover:border-[#001E78]'}">
          <input data-act="fileInput" type="file" accept="${ACCEPTED_EXTENSIONS.join(',')}" class="hidden"/>
          <span class="${state.isDragging?'text-[#F09600]':'text-gray-400'}">${ICONS.cloud(28)}</span>
          <div class="text-left"><p class="text-[14px] text-gray-600">Drop file or <span class="text-[#001E78] font-semibold">browse</span></p></div>
        </div>`
      : `<div class="relative border-2 border-green-500 rounded-xl p-3 bg-[#F0FFF4]">
          <div class="absolute -top-2 -right-2 w-6 h-6 rounded-md bg-green-500 flex items-center justify-center shadow-sm text-white">${ICONS.check(14)}</div>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-green-600">${ICONS.fileText(18)}</span>
              <div>
                <p class="font-medium text-[#001E78] text-[14px]">${escapeHtml(file.name)}</p>
                <p class="text-[12px] text-gray-500">${formatFileSize(file.size)}</p>
              </div>
            </div>
            <button data-act="removeFile" class="p-1 hover:bg-gray-200 rounded transition-colors text-gray-400">${ICONS.x(16)}</button>
          </div>
        </div>`;

    return `<div>
      <h3 class="text-lg md:text-xl font-bold text-[#001E78] mb-1">Got your logo or artwork?</h3>
      <p class="text-[13px] text-gray-500 mb-4">PNG, JPG, PDF, AI, EPS, SVG — or just send what you have.</p>
      ${dz}
      <div data-act="logoDesignUpsell" class="mt-3 p-3 border border-[#F09600] rounded-xl bg-[#FFF8E7] cursor-pointer hover:bg-[#FFF0D0] transition-colors">
        <div class="flex items-center gap-3">
          <span class="text-[#F09600]">${ICONS.penTool(18)}</span>
          <div class="flex-1">
            <p class="font-semibold text-[#001E78] text-[14px]">Need a logo designed?</p>
            <p class="text-[12px] text-gray-500">Professional design, you own the files</p>
          </div>
          <span class="font-bold text-[#001E78]">+$149</span>
        </div>
      </div>
      ${file ? '<button data-act="logoContinue" class="mt-3 w-full py-3 bg-[#001E78] text-white font-semibold rounded-xl hover:bg-[#001E78]/90 transition-colors">Continue →</button>' : ''}
      <button data-act="skipLogo" class="mt-3 block mx-auto text-gray-400 text-[13px] hover:text-[#001E78] transition-colors">I'll send my logo later →</button>
    </div>`;
  }
  function step4() {
    const tiers = [
      { id: 'standard', name: 'Standard', badge: 'Budget',  shortDesc: 'Events, teams, giveaways',                              priceText: 'Base',  mult: 1.0 },
      { id: 'pro',      name: 'Pro',      badge: 'Popular', shortDesc: 'Softer, more durable — most businesses choose this',    priceText: '+20%',  mult: 1.2 },
      { id: 'premium',  name: 'Premium',  badge: 'Best',    shortDesc: 'Top-tier materials for items that need to last',        priceText: '+40%',  mult: 1.4 },
    ];
    const rows = tiers.map(t => {
      const sel = state.productTier === t.id;
      const cls = sel ? 'border-2 border-[#001E78] bg-[#F0F4FF]' : 'border border-[#E0E0E0] bg-white hover:border-[#F09600]';
      const dot = sel ? `<div class="w-5 h-5 rounded-full flex items-center justify-center bg-[#001E78] text-white">${ICONS.check(12)}</div>` : '<div class="w-5 h-5 rounded-full border-2 border-gray-300"></div>';
      const badgeCls = t.id === 'pro' ? 'bg-[#F09600] text-white' : 'bg-gray-100 text-gray-600';
      const priceCls = t.mult > 1 ? 'text-[#001E78]' : 'text-green-600';
      return `<button data-act="tier" data-id="${t.id}" class="relative w-full p-3 rounded-xl text-left transition-all duration-200 ${cls}">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            ${dot}
            <div>
              <div class="flex items-center gap-2">
                <p class="font-bold text-[#001E78]">${t.name}</p>
                <span class="px-1.5 py-0.5 text-[10px] font-semibold rounded ${badgeCls}">${t.badge}</span>
              </div>
              <p class="text-[12px] text-gray-500">${t.shortDesc}</p>
            </div>
          </div>
          <span class="font-bold text-[14px] ${priceCls}">${t.priceText}</span>
        </div>
      </button>`;
    }).join('');
    return `<div>
      <h3 class="text-lg md:text-xl font-bold text-[#001E78] mb-1">Quality level?</h3>
      <p class="text-[13px] text-gray-500 mb-4">Affects the blank item — embroidery quality is always the same.</p>
      <div class="space-y-2">${rows}</div>
    </div>`;
  }
  function step5() {
    const swatches = COLOR_OPTIONS.map(c => {
      const sel = state.selectedColor === c.id;
      const ring = sel ? 'ring-[3px] ring-[#001E78] ring-offset-2' : '';
      const inner = c.hex === 'multi'
        ? '<div class="w-full h-full rounded-full overflow-hidden" style="background:conic-gradient(red,yellow,lime,aqua,blue,magenta,red)"></div>'
        : `<div class="w-full h-full rounded-full ${c.id==='white'?'border border-gray-300':''}" style="background-color:${c.hex}"></div>`;
      return `<button data-act="color" data-id="${c.id}" class="flex flex-col items-center">
        <div class="relative w-[52px] h-[52px] rounded-full transition-all duration-200 ${ring}">${inner}</div>
        <span class="text-[11px] text-gray-600 mt-2 text-center">${c.name}</span>
      </button>`;
    }).join('');
    return `<div>
      <h3 class="text-xl md:text-2xl font-bold text-[#001E78] mb-2">What color is your product?</h3>
      <p class="text-[15px] text-gray-500 mb-6">Pick the closest match — you can confirm the exact color when we follow up.</p>
      <div class="grid grid-cols-4 sm:grid-cols-6 gap-3">${swatches}</div>
      <p class="text-center text-[13px] text-gray-400 mt-6">Not sure? Pick the closest color — we'll confirm before ordering.</p>
    </div>`;
  }
  function step6() {
    const placements = (PLACEMENT_OPTIONS[state.product] || []);
    const rows = placements.map(p => {
      const sel = state.placements.includes(p.id);
      const cls = sel ? 'border-[2.5px] border-[#001E78] bg-[#F0F4FF]' : 'border-[1.5px] border-[#E0E0E0] bg-white hover:border-[#F09600]';
      const check = sel ? `<div class="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#001E78] flex items-center justify-center text-white">${ICONS.check(12)}</div>` : '';
      const svg = (PLACEMENT_SVG[state.product] && PLACEMENT_SVG[state.product][p.id]) || '';
      const priceCls = p.included ? 'text-green-600' : 'text-[#001E78]';
      const priceText = p.included ? 'Included' : `+$${p.price}/piece`;
      return `<button data-act="placement" data-id="${p.id}" class="relative p-3 rounded-xl transition-all duration-200 ${cls}">
        ${check}
        <div class="flex items-center gap-3">
          <div class="flex-shrink-0">${svg}</div>
          <div class="text-left">
            <p class="font-bold text-[14px] text-[#001E78]">${p.name}</p>
            <p class="text-[13px] ${priceCls}">${priceText}</p>
          </div>
        </div>
      </button>`;
    }).join('');
    const can = state.placements.length > 0;
    const continueBtn = can
      ? '<button data-act="step6Continue" class="w-full py-3 font-semibold rounded-xl bg-[#001E78] text-white hover:bg-[#001E78]/90 transition-colors">Continue →</button>'
      : '<button class="w-full py-3 font-semibold rounded-xl bg-gray-200 text-gray-400 cursor-not-allowed" disabled>Continue →</button>';
    return `<div>
      <h3 class="text-xl md:text-2xl font-bold text-[#001E78] mb-2">Where should the embroidery go?</h3>
      <p class="text-[15px] text-gray-500 mb-6">Select all locations you want. Each additional location adds to the price.</p>
      <div class="grid grid-cols-2 gap-3 mb-6">${rows}</div>
      ${continueBtn}
    </div>`;
  }
  function step7() {
    const addonRow = (key, icon, iconCls, label, price) => {
      const sel = state.addons[key];
      const cls = sel ? 'border-[#001E78] bg-[#F0F4FF]' : 'border-[#E0E0E0] hover:border-[#F09600]';
      const check = sel ? `<div class="w-5 h-5 rounded-full bg-[#001E78] flex items-center justify-center text-white">${ICONS.check(12)}</div>` : '';
      return `<button data-act="addon" data-key="${key}" class="w-full flex items-center justify-between p-3 rounded-xl border transition-all duration-200 ${cls}">
        <div class="flex items-center gap-3">
          <span class="${iconCls}">${icon}</span>
          <p class="font-medium text-[#001E78] text-[14px]">${label}</p>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[13px] text-[#001E78]">${price}</span>
          ${check}
        </div>
      </button>`;
    };
    const logoDesignRow = !state.needsLogoDesign
      ? addonRow('logoDesign', ICONS.penTool(18), 'text-[#F09600]', 'Add logo design', '+$149')
      : '';
    return `<div>
      <h3 class="text-lg md:text-xl font-bold text-[#001E78] mb-1">Any extras?</h3>
      <p class="text-[13px] text-gray-500 mb-4">Optional add-ons to customize your order.</p>
      <div class="space-y-2">
        ${addonRow('individualNames', ICONS.user(18), 'text-[#001E78]', 'Individual names or numbers', '+$3/pc')}
        ${addonRow('rushOrder', ICONS.zap(18), 'text-[#F09600]', 'Rush order — 2–3 business days', '+25%')}
        ${logoDesignRow}
      </div>
      <button data-act="step7Continue" class="mt-4 w-full py-3 bg-[#001E78] text-white font-semibold rounded-xl hover:bg-[#001E78]/90 transition-colors">Continue to your quote →</button>
      <button data-act="step7Continue" class="mt-2 block mx-auto text-gray-400 text-[13px] hover:text-[#001E78] transition-colors">Skip add-ons →</button>
    </div>`;
  }
  function step8() {
    if (state.isSubmitted) return postSubmit();
    const fv = state.fieldValidation;
    const okEmail = fv.email === true;
    const badEmail = fv.email === false;
    const okFirst = fv.firstName === true;
    const validForm = state.contact.firstName.trim() && state.contact.email.trim() && fv.email !== false;
    const sending = state.isSubmitting;
    const btnEnabled = validForm && !sending;
    const btnBg = btnEnabled ? 'linear-gradient(90deg,#F09600,#E10078)' : '#ccc';
    const btnDisabled = !btnEnabled ? 'disabled' : '';
    return `<div>
      <h3 class="text-lg md:text-xl font-bold text-[#001E78] mb-1">Where should we send your quote?</h3>
      <p class="text-[13px] text-gray-500 mb-4">We respond within 24 hours. Usually same day.</p>
      <form data-act="submit" class="space-y-3">
        <div>
          <label class="block text-[12px] font-bold text-[#001E78] mb-1">Full Name *</label>
          <div class="relative">
            <input data-field="firstName" type="text" required value="${escapeAttr(state.contact.firstName)}"
              class="w-full h-11 px-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#001E78]/50 ${fv.firstName===false?'border-red-500':'border-[#D0D0D0]'}"/>
            ${okFirst?`<div class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center text-white">${ICONS.check(10)}</div>`:''}
          </div>
        </div>
        <div>
          <label class="block text-[12px] font-bold text-[#001E78] mb-1">Email *</label>
          <div class="relative">
            <input data-field="email" type="email" required value="${escapeAttr(state.contact.email)}"
              class="w-full h-11 px-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#001E78]/50 ${badEmail?'border-red-500':'border-[#D0D0D0]'}"/>
            ${okEmail?`<div class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center text-white">${ICONS.check(10)}</div>`:''}
          </div>
          ${badEmail?'<p class="text-[11px] text-red-500 mt-1">Please enter a valid email</p>':''}
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[12px] font-bold text-[#001E78] mb-1">Phone <span class="font-normal text-gray-400">(opt)</span></label>
            <input data-field="phone" type="tel" value="${escapeAttr(state.contact.phone)}" placeholder="(555) 123-4567"
              class="w-full h-11 px-3 border border-[#D0D0D0] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#001E78]/50 text-[14px]"/>
          </div>
          <div>
            <label class="block text-[12px] font-bold text-[#001E78] mb-1">Business <span class="font-normal text-gray-400">(opt)</span></label>
            <input data-field="businessName" type="text" value="${escapeAttr(state.contact.businessName)}" placeholder="Company name"
              class="w-full h-11 px-3 border border-[#D0D0D0] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#001E78]/50 text-[14px]"/>
          </div>
        </div>
        <div class="flex flex-wrap justify-center gap-x-4 gap-y-1 py-2">
          ${['No prepayment','24hr response','Free proof'].map(t=>`<div class="flex items-center gap-1"><span class="text-[#F09600]">${ICONS.check(12)}</span><span class="text-[12px] text-gray-500">${t}</span></div>`).join('')}
        </div>
        <button type="submit" ${btnDisabled} class="w-full h-12 font-bold text-[16px] text-white rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed" style="background:${btnBg}">
          ${sending?'Sending...':'Get My Quote →'}
        </button>
        <div data-lit-status style="display:none;margin-top:.85rem;padding:.85rem 1rem;border-radius:.5rem;font-weight:600"></div>
      </form>
    </div>`;
  }
  function postSubmit() {
    const est = calculateEstimate();
    const product = (PRODUCTS.find(p => p.id === state.product) || {}).name || '';
    const color = (COLOR_OPTIONS.find(c => c.id === state.selectedColor) || {}).name || '';
    const tierName = { standard: 'Standard', pro: 'Pro', premium: 'Premium' }[state.productTier];
    const placementNames = state.placements.map(id => (PLACEMENT_OPTIONS[state.product] || []).find(p => p.id === id)).filter(Boolean).map(p => p.name);
    const placementCost = state.placements.reduce((sum, id) => {
      const p = (PLACEMENT_OPTIONS[state.product] || []).find(x => x.id === id);
      return sum + (p ? p.price : 0);
    }, 0);
    const logoLabel = state.needsLogoDesign || state.addons.logoDesign
      ? 'Design service added'
      : state.skipLogo ? 'Sending later' : state.logoFile ? 'Uploaded' : 'Not provided';
    const addonsList = [state.addons.individualNames && 'Individual names', state.addons.rushOrder && 'Rush order'].filter(Boolean).join(', ');

    return `<div class="text-center">
      <div class="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
        <svg class="w-8 h-8 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <h3 class="text-xl md:text-2xl font-bold text-[#001E78] mb-2">Here's your estimate, ${escapeHtml(state.contact.firstName)}. 🎉</h3>
      <p class="text-[15px] text-gray-500 mb-6">This is a starting estimate. We'll confirm the exact price when we review your artwork.</p>
      <div class="bg-[#F0F4FF] rounded-[14px] p-6 text-left mb-6">
        <div class="space-y-3 text-[14px]">
          <div class="flex justify-between"><span class="text-gray-600">Product</span><span class="text-[#001E78]">${escapeHtml(product)} × ${state.quantity}</span></div>
          <div class="flex justify-between"><span class="text-gray-600">Quality tier</span><span class="text-[#001E78]">${tierName}</span></div>
          <div class="flex justify-between"><span class="text-gray-600">Color</span><span class="text-[#001E78]">${escapeHtml(color)}</span></div>
          <div class="flex justify-between"><span class="text-gray-600">Placement(s)</span><span class="text-[#001E78]">${escapeHtml(placementNames.join(', ') || 'None')}</span></div>
          <div class="flex justify-between"><span class="text-gray-600">Logo</span><span class="text-[#001E78]">${logoLabel}</span></div>
          ${addonsList ? `<div class="flex justify-between"><span class="text-gray-600">Add-ons</span><span class="text-[#001E78]">${escapeHtml(addonsList)}</span></div>` : ''}
          <div class="border-t border-gray-300 pt-3 mt-3">
            <div class="flex justify-between"><span class="text-gray-600">Embroidery</span><span class="text-[#001E78]">$${(est.perPiece * state.quantity - est.oneTimeFees - placementCost * state.quantity).toFixed(2)}</span></div>
            ${est.oneTimeFees > 0 ? `<div class="flex justify-between mt-2"><span class="text-gray-600">One-time fees</span><span class="text-[#001E78]">$${est.oneTimeFees.toFixed(2)}</span></div>` : ''}
          </div>
          <div class="border-t-2 border-[#001E78]/20 pt-3 mt-3">
            <div class="flex justify-between"><span class="font-bold text-[#001E78] text-lg">Estimated Total</span><span class="font-bold text-[#001E78] text-xl">$${est.total.toFixed(2)}</span></div>
            <div class="flex justify-between mt-1"><span class="text-gray-500">Price per piece</span><span class="font-bold text-[#F09600]">$${est.perPiece.toFixed(2)}</span></div>
          </div>
        </div>
      </div>
      <div class="space-y-2 mb-6">
        ${['Free proof included before production starts','Estimated turnaround: 5–7 business days',"We'll follow up within 24 hours to confirm details"].map(t=>`<div class="flex items-center justify-center gap-2"><span class="text-green-600">${ICONS.check(14)}</span><span class="text-[13px] text-gray-600">${t}</span></div>`).join('')}
      </div>
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-6">
        <p class="text-[13px] text-amber-800">⏰ We typically book out 1–2 weeks for bulk orders. Early booking is recommended.</p>
      </div>
      <a href="mailto:info@lakesidethreadz.com?subject=Approve my quote&body=${encodeURIComponent('Hi — please move forward with the quote you just sent to ' + state.contact.email)}" class="block w-full h-[52px] flex items-center justify-center font-bold text-white rounded-xl mb-3" style="background:linear-gradient(90deg,#F09600,#E10078)">Approve &amp; Start My Order →</a>
      <a href="/contact" class="block w-full h-11 flex items-center justify-center font-semibold text-[#001E78] border-2 border-[#001E78] rounded-xl hover:bg-[#F0F4FF] transition-colors">I have a question first →</a>
      <button data-act="startOver" class="flex items-center justify-center gap-2 mx-auto mt-6 text-gray-500 text-sm hover:text-[#001E78] transition-colors">${ICONS.refresh(14)} Start a new quote</button>
    </div>`;
  }

  // ============== Helpers ==============
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function formatFileSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function validateFile(file) {
    const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
    return ACCEPTED_EXTENSIONS.indexOf(ext) !== -1;
  }

  // ============== Render + event dispatch ==============
  function render(skipAnim) {
    if (!root) return;
    const est = calculateEstimate();
    if (!skipAnim && est.total !== state.prevTotal && est.total > 0) {
      state.priceAnimating = true;
      state.prevTotal = est.total;
      setTimeout(() => { state.priceAnimating = false; render(true); }, 300);
    }
    let step;
    switch (state.currentStep) {
      case 1: step = step1(); break;
      case 2: step = step2(); break;
      case 3: step = step3(); break;
      case 4: step = step4(); break;
      case 5: step = step5(); break;
      case 6: step = step6(); break;
      case 7: step = step7(); break;
      case 8: step = step8(); break;
      default: step = step1();
    }
    const animCls = state.isAnimating
      ? (state.direction === 'forward' ? '-translate-x-10 opacity-0' : 'translate-x-10 opacity-0')
      : 'translate-x-0 opacity-100';
    root.innerHTML = `<div class="max-w-[720px] mx-auto">
      <div class="bg-white rounded-[20px] p-6 md:p-10 overflow-hidden" style="box-shadow:0 4px 40px rgba(0,15,90,0.10)">
        ${progressBar()}
        ${backButton()}
        <div class="transition-all duration-[220ms] ${animCls}">${step}</div>
        ${priceTicker(est)}
      </div>
    </div>`;
  }

  function bind() {
    root.addEventListener('click', (e) => {
      const target = e.target.closest('[data-act]');
      if (!target) return;
      const act = target.getAttribute('data-act');
      const id = target.getAttribute('data-id');
      const handlers = {
        back:           () => goToStep(state.currentStep - 1, 'back'),
        product:        () => { state.product = id; state.placements = []; render(); autoAdvance(2); },
        qty:            () => { const q = parseInt(target.getAttribute('data-q')); state.quantity = q; state.customQuantity = false; render(); autoAdvance(3, 400); },
        showCustomQty:  () => { state.showCustomQty = true; render(); },
        qtyMinus:       () => { state.quantity = Math.max(1, state.quantity - 1); state.customQuantity = true; render(); },
        qtyPlus:        () => { state.quantity = Math.min(500, state.quantity + 1); state.customQuantity = true; render(); },
        qtyContinue:    () => { if (state.quantity >= 1) goToStep(3, 'forward'); },
        dropzone:       () => { const inp = root.querySelector('[data-act="fileInput"]'); if (inp) inp.click(); },
        removeFile:     (ev) => { ev && ev.stopPropagation && ev.stopPropagation(); state.logoFile = null; render(); },
        logoDesignUpsell: () => { state.needsLogoDesign = true; goToStep(4, 'forward'); },
        logoContinue:   () => goToStep(4, 'forward'),
        skipLogo:       () => { state.skipLogo = true; state.logoFile = null; goToStep(4, 'forward'); },
        tier:           () => { state.productTier = id; render(); autoAdvance(5); },
        color:          () => { state.selectedColor = id; render(); autoAdvance(6, 300); },
        placement:      () => {
          const has = state.placements.indexOf(id) !== -1;
          state.placements = has ? state.placements.filter(p => p !== id) : state.placements.concat([id]);
          render();
        },
        step6Continue:  () => goToStep(7, 'forward'),
        addon:          () => { const k = target.getAttribute('data-key'); state.addons[k] = !state.addons[k]; render(); },
        step7Continue:  () => goToStep(8, 'forward'),
        startOver:      () => { state = initialState(); render(); },
      };
      const fn = handlers[act];
      if (fn) { e.preventDefault(); fn(e); }
    });

    // File input change
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('[data-act="fileInput"]')) {
        const f = t.files && t.files[0];
        if (f && validateFile(f)) { state.logoFile = { name: f.name, size: f.size }; state.skipLogo = false; render(); }
      }
      if (t && t.matches && t.matches('[data-act="qtyInput"]')) {
        const v = Math.min(500, Math.max(1, parseInt(t.value) || 0));
        state.quantity = v; state.customQuantity = true; render();
      }
    });

    // Drag/drop on dropzone
    root.addEventListener('dragover', (e) => {
      const dz = e.target.closest('[data-act="dropzone"]');
      if (!dz) return;
      e.preventDefault();
      if (!state.isDragging) { state.isDragging = true; render(true); }
    });
    root.addEventListener('dragleave', (e) => {
      const dz = e.target.closest('[data-act="dropzone"]');
      if (!dz) return;
      e.preventDefault();
      if (state.isDragging) { state.isDragging = false; render(true); }
    });
    root.addEventListener('drop', (e) => {
      const dz = e.target.closest('[data-act="dropzone"]');
      if (!dz) return;
      e.preventDefault();
      state.isDragging = false;
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && validateFile(f)) { state.logoFile = { name: f.name, size: f.size }; state.skipLogo = false; }
      render();
    });

    // Form input typing — update state silently, then refresh submit-button enabled
    // state in-place (no full re-render, which would steal focus from the input
    // currently being typed in).
    root.addEventListener('input', (e) => {
      const t = e.target;
      if (!t || !t.matches || !t.matches('input[data-field]')) return;
      const field = t.getAttribute('data-field');
      state.contact[field] = t.value;
      refreshSubmitButton();
    });
    // Validation on blur — update field's red border + check via direct DOM edit
    // (again, no full re-render).
    root.addEventListener('focusout', (e) => {
      const t = e.target;
      if (!t || !t.matches || !t.matches('input[data-field]')) return;
      const field = t.getAttribute('data-field');
      const v = t.value;
      if (field === 'email') {
        const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        state.fieldValidation.email = v ? ok : null;
      } else if (field === 'firstName') {
        state.fieldValidation.firstName = v.trim().length > 0 ? true : null;
      }
      refreshFieldValidation(field, t);
      refreshSubmitButton();
    });

    // Submit
    root.addEventListener('submit', async (e) => {
      const f = e.target.closest('form[data-act="submit"]');
      if (!f) return;
      e.preventDefault();
      if (!state.contact.firstName || !state.contact.email) return;
      state.isSubmitting = true; render();
      try {
        const est = calculateEstimate();
        const productName = (PRODUCTS.find(p => p.id === state.product) || {}).name || '';
        const placementNames = state.placements.map(id => {
          const p = (PLACEMENT_OPTIONS[state.product] || []).find(x => x.id === id);
          return p ? p.name : id;
        });
        const payload = {
          contact: state.contact,
          product: productName,
          quantity: state.quantity,
          tier: state.productTier,
          color: (COLOR_OPTIONS.find(c => c.id === state.selectedColor) || {}).name || '',
          placements: placementNames,
          addons: state.addons,
          estimate: { perPiece: est.perPiece, total: est.total, oneTimeFees: est.oneTimeFees },
          needsLogoDesign: state.needsLogoDesign,
          skipLogo: state.skipLogo,
          logoFile: state.logoFile ? { name: state.logoFile.name, size: state.logoFile.size } : null,
        };
        const r = await fetch('/api/submit-quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        state.isSubmitted = true;
        if (!r.ok) {
          // Still show post-submit (matches original UX), but log the error.
          console.error('submit-quote failed', r.status);
        }
      } catch (err) {
        console.error('submit-quote threw', err);
        state.isSubmitted = true; // original swallows errors too
      } finally {
        state.isSubmitting = false;
        render();
      }
    });
  }

  function refreshSubmitButton() {
    const btn = root.querySelector('button[type=submit]');
    if (!btn) return;
    const fv = state.fieldValidation;
    const valid = state.contact.firstName.trim() && state.contact.email.trim() && fv.email !== false;
    const enabled = valid && !state.isSubmitting;
    btn.disabled = !enabled;
    btn.style.background = enabled ? 'linear-gradient(90deg,#F09600,#E10078)' : '#ccc';
    btn.textContent = state.isSubmitting ? 'Sending...' : 'Get My Quote →';
  }
  function refreshFieldValidation(field, input) {
    const fv = state.fieldValidation;
    const ok = fv[field] === true;
    const bad = fv[field] === false;
    // border color
    input.classList.toggle('border-red-500', bad);
    input.classList.toggle('border-[#D0D0D0]', !bad);
    // success check mark — insert/remove an absolute-positioned indicator
    const wrap = input.parentElement; // the .relative wrapper
    if (!wrap || !wrap.classList.contains('relative')) return;
    let mark = wrap.querySelector('[data-lit-checkmark]');
    if (ok && !mark) {
      mark = document.createElement('div');
      mark.setAttribute('data-lit-checkmark', '');
      mark.className = 'absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center text-white';
      mark.innerHTML = ICONS.check(10);
      wrap.appendChild(mark);
    } else if (!ok && mark) {
      mark.remove();
    }
    // email-only inline error message
    if (field === 'email') {
      let err = wrap.parentElement.querySelector('[data-lit-emailerr]');
      if (bad && !err) {
        err = document.createElement('p');
        err.setAttribute('data-lit-emailerr', '');
        err.className = 'text-[11px] text-red-500 mt-1';
        err.textContent = 'Please enter a valid email';
        wrap.parentElement.appendChild(err);
      } else if (!bad && err) {
        err.remove();
      }
    }
  }

  function mount() {
    root = document.getElementById('lit-quote');
    if (!root) return;
    render();
    bind();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
