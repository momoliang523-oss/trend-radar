// 客户反馈入口:悬浮按钮 + 弹窗(星级 + 文本 + 选填联系方式)
import { el } from '../fmt.js';
import { postJSON } from '../api.js';
import { toast } from './toast.js';

export function initFeedback() {
  const root = document.getElementById('feedback-root');
  if (!root) return;

  root.append(el('button', { class: 'feedback-fab', text: '💬', title: '反馈', onclick: open }));

  function open() {
    if (document.querySelector('.feedback-mask')) return;
    const rating = { v: 5 };

    const stars = el('div', { class: 'fb-stars-row' });
    const refreshStars = () => {
      stars.innerHTML = '';
      for (let i = 1; i <= 5; i++) {
        stars.append(
          el('button', {
            class: `fb-star${i <= rating.v ? ' on' : ''}`,
            text: '★',
            onclick: () => {
              rating.v = i;
              refreshStars();
            },
          })
        );
      }
    };
    refreshStars();

    const textarea = el('textarea', { class: 'fb-textarea', placeholder: '说说你的建议、需求或遇到的问题…' });
    const contact = el('input', { class: 'fb-input', placeholder: '联系方式(选填)' });
    const submit = el('button', {
      class: 'go-btn',
      text: '提交反馈',
      onclick: async () => {
        const text = textarea.value.trim();
        if (!text) {
          toast('请先填写反馈内容', 'info');
          return;
        }
        submit.disabled = true;
        submit.textContent = '提交中…';
        try {
          await postJSON('/api/feedback', {
            rating: rating.v,
            text,
            contact: contact.value.trim(),
            page: location.hash.replace(/^#\/?/, '') || 'calendar',
          });
          toast('感谢反馈 🙏');
          mask.remove();
        } catch (e) {
          toast(e.message, 'err');
          submit.disabled = false;
          submit.textContent = '提交反馈';
        }
      },
    });
    const cancel = el('button', { class: 'fb-cancel', text: '取消', onclick: () => mask.remove() });

    const mask = el('div', { class: 'feedback-mask' });
    const sheet = el('div', { class: 'feedback-sheet' }, [
      el('div', { class: 'fb-title', text: '💬 反馈' }),
      el('div', { class: 'fb-label', text: '整体评价' }),
      stars,
      el('div', { class: 'fb-label', text: '反馈内容' }),
      textarea,
      el('div', { class: 'fb-label', text: '联系方式(选填)' }),
      contact,
      el('div', { class: 'fb-actions' }, [cancel, submit]),
    ]);
    mask.append(sheet);
    mask.addEventListener('click', (e) => {
      if (e.target === mask) mask.remove();
    });
    document.body.append(mask);
  }
}
