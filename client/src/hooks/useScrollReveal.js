import { useEffect } from 'react';

export function useScrollReveal(dependencies = []) {
  useEffect(() => {
    const targets = [...document.querySelectorAll('.section,.story,.pet-card,.panel,.metric,.flow-card,.question,.result,.profile-grid,.page-hero,.auth-card')];
    targets.forEach(element => element.classList.add('scroll-reveal'));
    if (typeof IntersectionObserver !== 'function') {
      targets.forEach(element => element.classList.add('in-view'));
      return undefined;
    }
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      }
    }), { threshold: 0.12 });
    targets.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, dependencies);
}
