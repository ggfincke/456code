import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'

import { QRCodeSvg } from '../../../../../apps/web/src/components/ui/qr-code'

describe('QRCodeSvg', () =>
{
  it('renders with explicit high-contrast colors by default', () =>
  {
    const markup = renderToStaticMarkup(<QRCodeSvg value="https://example.com/pair" />)

    expect(markup).toContain('fill="#fff"')
    expect(markup).toContain('fill="#000"')
    expect(markup).not.toContain('fill="currentColor"')
  })
})
