/* mirror.js — restore minimal interactivity after SPA strip */
(function(){
  'use strict';
  // Wait for DOM ready (defer attribute already gates parse, but be safe).
  function ready(fn){ document.readyState!=='loading' ? fn() : document.addEventListener('DOMContentLoaded', fn); }

  ready(function(){
    // ---- Desktop dropdowns ----
    // Real dropdown triggers in the captured nav are <button> elements that
    // contain a chevron-down SVG (lucide-chevron-down). Their dropdown panel
    // is the immediately following sibling <div>.
    var navButtons = [].filter.call(
      document.querySelectorAll('nav button'),
      function(b){ return b.querySelector('svg.lucide-chevron-down'); }
    );
    navButtons.forEach(function(btn){
      var panel = btn.nextElementSibling;
      while(panel && (panel.tagName !== 'DIV' || !panel.querySelector('a'))){
        panel = panel.nextElementSibling;
      }
      if(!panel) return;
      panel.setAttribute('data-dropdown-panel','');
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
