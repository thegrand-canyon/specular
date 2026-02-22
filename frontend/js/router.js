import { renderLeaderboard } from './pages/leaderboard.js';
import { renderPoolDetail  } from './pages/pool-detail.js';
import { renderSupply      } from './pages/supply.js';
import { renderBorrow      } from './pages/borrow.js';
import { renderPortfolio   } from './pages/portfolio.js';
import { renderIdentity    } from './pages/identity.js';

const NAV_LINKS = document.querySelectorAll('nav a');

function setActiveNav(hash) {
    NAV_LINKS.forEach(a => {
        const href = a.getAttribute('href').replace('#', '');
        const active = hash === href || (hash === '' && href === 'leaderboard')
            || (hash.startsWith('pool/') && href === 'leaderboard');
        a.classList.toggle('active', active);
    });
}

function route() {
    const raw  = window.location.hash.replace('#', '');
    const path = raw.split('?')[0];

    setActiveNav(path);

    if (path.startsWith('pool/')) {
        const agentId = BigInt(path.split('/')[1] || 0);
        renderPoolDetail(agentId);
        return;
    }

    switch (path) {
        case 'supply':    renderSupply();      break;
        case 'borrow':    renderBorrow();      break;
        case 'portfolio': renderPortfolio();   break;
        case 'identity':  renderIdentity();    break;
        default:          renderLeaderboard(); break;
    }
}

export function initRouter() {
    window.addEventListener('hashchange', route);
    route();
}
