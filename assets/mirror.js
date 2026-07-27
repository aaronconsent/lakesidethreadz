/* mirror.js — restore minimal interactivity after SPA strip */
(function(){
  'use strict';
  // Wait for DOM ready (defer attribute already gates parse, but be safe).
  function ready(fn){ document.readyState!=='loading' ? fn() : document.addEventListener('DOMContentLoaded', fn); }

  ready(function(){
    // ---- Desktop dropdowns ----
    // Root cause of "menu doesn't work": React rendered the dropdown panels
    // conditionally on click; the snapshot captured the CLOSED state so the
    // panels don't exist in the DOM at all. Buttons have no next-sibling <div>
    // to reveal. Fix: build the panel from a hardcoded route map (stable —
    // sitemap changes are handled in enhance.py, not on the client).
    var MENUS = {
      'Services': [
        {href:'/services/',                          text:'All Services →', bold:true},
        {href:'/business-orders/',                   text:'For Businesses & Teams'},
        {href:'/services/embroidered-polos/',        text:'Embroidered Polos'},
        {href:'/services/embroidered-hats-caps/',    text:'Embroidered Hats & Caps'},
        {href:'/services/work-shirts-uniforms/',     text:'Work Shirts & Uniforms'},
        {href:'/services/team-uniforms/',            text:'Team Uniforms'},
        {href:'/services/church-ministry-apparel/',  text:'Church & Ministry Apparel'},
        {href:'/services/corporate-embroidery/',     text:'Corporate Embroidery'},
        {href:'/services/embroidered-bags-totes/',   text:'Embroidered Bags & Totes'},
        {href:'/services/monogramming/',             text:'Monogramming'},
        {href:'/services/wedding-embroidery/',       text:'Wedding Embroidery'},
        {href:'/services/hunting-fishing-apparel/',  text:'Hunting & Fishing Apparel'},
        {href:'/services/logo-design/',              text:'Logo Design'},
        {href:'/services/embroidery-digitizing/',    text:'Embroidery Digitizing'},
        {href:'/services/graphic-design/',           text:'Graphic Design'},
      ],
      'Areas': [
        {href:'/service-area/onalaska-tx/',    text:'Onalaska, TX'},
        {href:'/service-area/livingston-tx/',  text:'Livingston, TX'},
        {href:'/service-area/lake-livingston/',text:'Lake Livingston'},
        {href:'/service-area/coldspring-tx/',  text:'Coldspring, TX'},
        {href:'/service-area/huntsville-tx/',  text:'Huntsville, TX'},
        {href:'/service-area/cleveland-tx/',   text:'Cleveland, TX'},
        {href:'/service-area/splendora-tx/',   text:'Splendora, TX'},
        {href:'/service-area/lufkin-tx/',      text:'Lufkin, TX'},
      ],
    };

    // Match buttons that are DIRECT children of the DESKTOP nav row (hidden on
    // mobile via md:flex/lg:flex parent) — skip mobile-panel sub-buttons which
    // have their own pre-rendered collapsible lists that React DID capture.
    var navButtons = [].filter.call(
      document.querySelectorAll('nav button'),
      function(b){
        if(!b.querySelector('svg.lucide-chevron-down')) return false;
        // Skip buttons that are already inside a captured mobile menu
        // (their sub-content was rendered by React as a collapsible list).
        var mobilePanel = b.closest('[class*="md:hidden"]');
        if(mobilePanel) return false;
        // Match by button text against our known top-level menus.
        var label = (b.innerText || '').trim().split(/\s/)[0];
        return !!MENUS[label];
      }
    );

    navButtons.forEach(function(btn){
      var label = (btn.innerText || '').trim().split(/\s/)[0];
      var items = MENUS[label] || [];
      if(!items.length) return;

      // Build the panel as a sibling of the button. Style inline so we don't
      // depend on Tailwind classes that may or may not have been JIT-compiled.
      var panel = document.createElement('div');
      panel.setAttribute('data-dropdown-panel','');
      panel.style.cssText = 'position:absolute;top:100%;left:0;margin-top:8px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,15,90,0.18);padding:8px 0;min-width:260px;z-index:60';
      items.forEach(function(it){
        var a = document.createElement('a');
        a.href = it.href;
        a.textContent = it.text;
        a.style.cssText = 'display:block;padding:8px 16px;color:#001E78;text-decoration:none;font-size:14px;'+(it.bold?'font-weight:700;border-bottom:1px solid #eee;margin-bottom:4px;padding-bottom:10px;':'font-weight:500;');
        a.addEventListener('mouseover', function(){ a.style.background='#F0F4FF'; });
        a.addEventListener('mouseout',  function(){ a.style.background='transparent'; });
        panel.appendChild(a);
      });
      // The button's parent is <div class="relative"> — perfect for absolute
      // positioning of the panel. Insert as parent's child.
      var wrap = btn.parentElement;
      if(wrap) {
        wrap.appendChild(panel);
      } else {
        return;
      }

      btn.setAttribute('aria-haspopup','true');
      btn.setAttribute('aria-expanded','false');
      btn.addEventListener('click', function(e){
        e.preventDefault(); e.stopPropagation();
        var open = panel.classList.toggle('mirror-open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        document.querySelectorAll('[data-dropdown-panel].mirror-open').forEach(function(p){
          if(p !== panel) p.classList.remove('mirror-open');
        });
      });
    });

    document.addEventListener('click', function(e){
      // Click outside any panel closes them.
      if(e.target.closest('[data-dropdown-panel]') || e.target.closest('nav button')) return;
      document.querySelectorAll('[data-dropdown-panel].mirror-open').forEach(function(p){
        p.classList.remove('mirror-open');
      });
    });

    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape'){
        document.querySelectorAll('[data-dropdown-panel].mirror-open').forEach(function(p){
          p.classList.remove('mirror-open');
        });
      }
    });

    // ---- Mobile hamburger ----
    var toggle = document.querySelector('[aria-label="Toggle menu"]');
    if(toggle){
      var navRoot = toggle.closest('nav') || document;
      // Mobile panel: a div that's md:hidden (mobile-only) and contains nav links.
      var panel = null;
      var divs = navRoot.querySelectorAll('div');
      for(var i=0;i<divs.length;i++){
        var c = divs[i];
        if(c.className && c.className.indexOf && c.className.indexOf('md:hidden') !== -1
           && c.querySelectorAll('a[href]').length >= 3){
          panel = c; break;
        }
      }
      if(panel){
        panel.setAttribute('data-mobile-panel','');
        toggle.addEventListener('click', function(e){
          e.preventDefault();
          panel.classList.toggle('mirror-open');
        });
      }
    }
  });
})();
